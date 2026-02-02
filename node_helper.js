const NodeHelper = require("node_helper");
const Log = require("logger");
const fetch = require("node-fetch");

const DEFAULT_CONFIG = {
  auth: {
    token: null,
    tokenEnvVar: "GITHUB_TOKEN",
    apiBaseUrl: "https://api.github.com"
  },

  targets: [],

  query: {
    state: "open",
    includeDrafts: true
  },

  display: {
    showRepoName: true,
    showTimestamp: true,
    timestampField: "updated_at",
    timeFormat: "relative",
    showAdditionsDeletions: true,
    showFilesChanged: true,
    showAuthorAvatar: true,
    truncateTitleAt: 90
  },

  grouping: {
    mode: "none"
  },

  limits: {
    maxTotal: 20,
    maxPerRepo: 10
  },

  refresh: {
    updateIntervalMs: 300000,
    backoffOnRateLimit: true
  },

  alerts: {
    showOnAuthError: true
  }
};

module.exports = NodeHelper.create({
  start() {
    this.instances = new Map();
    this.timers = new Map();
    this.httpCache = new Map();
    this.repoMetaCache = new Map();
    this.backoffUntil = null;
  },

  socketNotificationReceived(notification, payload) {
    if (!payload || !payload.instanceId) {
      return;
    }

    if (notification === "GITPUSHY_CONFIG") {
      this.registerInstance(payload.instanceId, payload.config);
      return;
    }

    if (notification === "GITPUSHY_FETCH") {
      this.registerInstance(payload.instanceId, payload.config);
      this.fetchAndSend(payload.instanceId);
    }
  },

  registerInstance(instanceId, config) {
    const normalized = this.applyDefaults(config || {}, DEFAULT_CONFIG);
    this.instances.set(instanceId, normalized);

    const existing = this.timers.get(instanceId);
    const interval = normalized.refresh.updateIntervalMs;

    if (!existing) {
      const timer = setInterval(() => this.fetchAndSend(instanceId), interval);
      this.timers.set(instanceId, { timer, interval });
      return;
    }

    if (existing.interval !== interval) {
      clearInterval(existing.timer);
      const timer = setInterval(() => this.fetchAndSend(instanceId), interval);
      this.timers.set(instanceId, { timer, interval });
    }
  },

  async fetchAndSend(instanceId) {
    const config = this.instances.get(instanceId);
    if (!config) {
      return;
    }

    if (this.isRateLimited(config)) {
      this.sendSocketNotification("GITPUSHY_ERROR", {
        instanceId,
        message: "GitHub rate limit hit. Waiting to retry.",
        prs: this.getCachedData(instanceId)
      });
      return;
    }

    const token = this.getAuthToken(config);
    if (!token && config.alerts.showOnAuthError) {
      this.sendSocketNotification("GITPUSHY_ERROR", {
        instanceId,
        message: `Missing GitHub token (set auth.token or env var ${config.auth.tokenEnvVar}).`,
        prs: this.getCachedData(instanceId)
      });
      return;
    }

    try {
      const prs = await this.fetchAllTargets(config, token);
      this.instances.get(instanceId).lastData = prs;
      this.sendSocketNotification("GITPUSHY_DATA", {
        instanceId,
        prs
      });
    } catch (error) {
      const message = this.formatError(error);
      this.sendSocketNotification("GITPUSHY_ERROR", {
        instanceId,
        message,
        prs: this.getCachedData(instanceId)
      });
    }
  },

  getCachedData(instanceId) {
    const config = this.instances.get(instanceId);
    return (config && config.lastData) || [];
  },

  isRateLimited(config) {
    if (!config.refresh.backoffOnRateLimit) {
      return false;
    }
    if (!this.backoffUntil) {
      return false;
    }
    return Date.now() < this.backoffUntil;
  },

  getAuthToken(config) {
    if (config.auth.token && String(config.auth.token).trim().length > 0) {
      return config.auth.token;
    }

    const envVar = config.auth.tokenEnvVar;
    return envVar ? process.env[envVar] : null;
  },

  async fetchAllTargets(config, token) {
    const results = [];
    const targets = Array.isArray(config.targets) ? config.targets : [];
    for (const target of targets) {
      const prs = await this.fetchRepoPulls(target, config, token);
      const limited = prs.slice(0, config.limits.maxPerRepo);
      results.push(...limited);
    }

    const sorted = results.sort((a, b) => {
      const timeA = new Date(a.updated_at).getTime();
      const timeB = new Date(b.updated_at).getTime();
      return timeB - timeA;
    });

    return sorted.slice(0, config.limits.maxTotal);
  },

  async fetchRepoPulls(target, config, token) {
    const owner = target.owner;
    const repo = target.repo;
    const repoKey = `${owner}/${repo}`;

    const baseBranches = await this.resolveBaseBranches(target, config, token);
    const listConfigs = baseBranches.length > 0 ? baseBranches : [null];

    const pulls = [];
    for (const base of listConfigs) {
      const listUrl = this.buildPullsUrl(config.auth.apiBaseUrl, owner, repo, {
        state: config.query.state,
        base
      });

      const listCacheKey = `pulls:${repoKey}:${base || "all"}:${config.query.state}`;
      const listData = await this.fetchAllPages(
        listUrl,
        token,
        listCacheKey,
        config.refresh.updateIntervalMs
      );

      pulls.push(...listData);
    }

    const unique = this.uniquePulls(pulls);
    const filtered = unique.filter((pr) => {
      if (!config.query.includeDrafts && pr.draft) {
        return false;
      }
      return true;
    });

    const enriched = [];
    for (const pr of filtered) {
      const details = await this.fetchPullDetails(
        config.auth.apiBaseUrl,
        owner,
        repo,
        pr.number,
        token,
        config.refresh.updateIntervalMs
      );

      enriched.push({
        repo,
        repoLabel: target.displayName || repo,
        owner,
        number: pr.number,
        title: pr.title,
        html_url: pr.html_url,
        updated_at: pr.updated_at,
        created_at: pr.created_at,
        authorLogin: (pr.user && pr.user.login) || (details.user && details.user.login) || null,
        authorAvatarUrl:
          (pr.user && pr.user.avatar_url) ||
          (details.user && details.user.avatar_url) ||
          null,
        additions: details.additions,
        deletions: details.deletions,
        changed_files: details.changed_files,
        draft: pr.draft,
        base: pr.base
      });
    }

    return enriched;
  },

  async resolveBaseBranches(target, config, token) {
    const mode = target.baseBranchesMode || "defaultOnly";
    if (mode === "all") {
      return [];
    }

    if (mode === "list") {
      if (Array.isArray(target.baseBranches) && target.baseBranches.length > 0) {
        return target.baseBranches;
      }
      return this.resolveDefaultBranch(target, config, token);
    }

    if (target.defaultBranchOverride) {
      return [target.defaultBranchOverride];
    }

    return this.resolveDefaultBranch(target, config, token);
  },

  async resolveDefaultBranch(target, config, token) {
    const cacheKey = `${target.owner}/${target.repo}`;
    const cached = this.repoMetaCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < 3600000) {
      return cached.defaultBranch ? [cached.defaultBranch] : [];
    }

    try {
      const url = `${config.auth.apiBaseUrl}/repos/${target.owner}/${target.repo}`;
      const data = await this.httpGet(
        url,
        token,
        `repo:${cacheKey}`,
        3600000
      );
      const defaultBranch = data.default_branch || null;
      this.repoMetaCache.set(cacheKey, {
        defaultBranch,
        fetchedAt: Date.now()
      });
      return defaultBranch ? [defaultBranch] : [];
    } catch (error) {
      Log.warn(`MMM-GitPushy: Failed to resolve default branch for ${cacheKey}: ${error}`);
      return [];
    }
  },

  uniquePulls(pulls) {
    const seen = new Set();
    const unique = [];
    pulls.forEach((pr) => {
      const key = pr.number;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      unique.push(pr);
    });
    return unique;
  },

  async fetchPullDetails(apiBaseUrl, owner, repo, number, token, ttl) {
    const url = `${apiBaseUrl}/repos/${owner}/${repo}/pulls/${number}`;
    const cacheKey = `pull:${owner}/${repo}/${number}`;
    return this.httpGet(url, token, cacheKey, ttl);
  },

  buildPullsUrl(apiBaseUrl, owner, repo, { state, base }) {
    const url = new URL(`${apiBaseUrl}/repos/${owner}/${repo}/pulls`);
    url.searchParams.set("state", state || "open");
    url.searchParams.set("per_page", "100");
    if (base) {
      url.searchParams.set("base", base);
    }
    return url.toString();
  },

  async fetchAllPages(url, token, cacheKey, ttl) {
    const all = [];
    let nextUrl = url;
    let page = 1;

    while (nextUrl) {
      const pageCacheKey = `${cacheKey}:page:${page}`;
      const response = await this.httpGet(nextUrl, token, pageCacheKey, ttl, true);
      all.push(...response.data);
      nextUrl = response.nextUrl;
      page += 1;
    }

    return all;
  },

  async httpGet(url, token, cacheKey, ttl, includePagination = false) {
    const now = Date.now();
    const cached = this.httpCache.get(cacheKey);
    if (cached && now - cached.fetchedAt < ttl) {
      return cached.data;
    }

    const headers = {
      "User-Agent": "MMM-GitPushy"
    };

    if (token) {
      headers.Authorization = `token ${token}`;
    }

    if (cached && cached.etag) {
      headers["If-None-Match"] = cached.etag;
    }

    const response = await fetch(url, { headers });

    if (response.status === 304 && cached) {
      cached.fetchedAt = now;
      return cached.data;
    }

    if (!response.ok) {
      await this.handleRateLimit(response);
      const text = await response.text();
      throw new Error(`GitHub API error ${response.status}: ${text}`);
    }

    const data = await response.json();
    const etag = response.headers.get("etag");

    let payload = data;
    if (includePagination) {
      payload = {
        data,
        nextUrl: this.getNextPageUrl(response.headers.get("link"))
      };
    }

    this.httpCache.set(cacheKey, {
      data: payload,
      etag,
      fetchedAt: now
    });

    return payload;
  },

  async handleRateLimit(response) {
    const remaining = response.headers.get("x-ratelimit-remaining");
    const reset = response.headers.get("x-ratelimit-reset");
    if (remaining === "0" && reset) {
      const resetMs = Number(reset) * 1000;
      if (!Number.isNaN(resetMs)) {
        this.backoffUntil = resetMs;
      }
    }
  },

  getNextPageUrl(linkHeader) {
    if (!linkHeader) {
      return null;
    }
    const links = linkHeader.split(",");
    for (const link of links) {
      const match = link.match(/<([^>]+)>;\s*rel="next"/);
      if (match) {
        return match[1];
      }
    }
    return null;
  },

  formatError(error) {
    if (error && error.message) {
      return error.message;
    }
    return "Unknown error fetching GitHub pull requests.";
  },

  applyDefaults(config, defaults) {
    if (config === null || typeof config !== "object") {
      return defaults;
    }

    const merged = Array.isArray(defaults) ? [] : {};
    Object.keys(defaults).forEach((key) => {
      const value = defaults[key];
      if (config[key] === undefined) {
        merged[key] = value;
        return;
      }

      if (value && typeof value === "object" && !Array.isArray(value)) {
        merged[key] = this.applyDefaults(config[key], value);
        return;
      }

      merged[key] = config[key];
    });

    Object.keys(config).forEach((key) => {
      if (merged[key] === undefined) {
        merged[key] = config[key];
      }
    });

    return merged;
  }
});
