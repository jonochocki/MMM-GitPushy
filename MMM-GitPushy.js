/* global Module, moment */

Module.register("MMM-GitPushy", {
  defaults: {
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
  },

  start() {
    this.prs = [];
    this.loaded = false;
    this.error = null;
    this.instanceId = this.identifier;

    this.sendConfig();
    this.scheduleUpdate();
  },

  sendConfig() {
    this.sendSocketNotification("GITPUSHY_CONFIG", {
      instanceId: this.instanceId,
      config: this.config
    });
  },

  scheduleUpdate() {
    const interval = this.config.refresh.updateIntervalMs;
    this.fetchData();
    setInterval(() => this.fetchData(), interval);
  },

  fetchData() {
    this.sendSocketNotification("GITPUSHY_FETCH", {
      instanceId: this.instanceId,
      config: this.config
    });
  },

  getStyles() {
    return ["MMM-GitPushy.css"];
  },

  getDom() {
    const wrapper = document.createElement("div");
    wrapper.className = "gitpushy";

    if (this.error) {
      const errorEl = document.createElement("div");
      errorEl.className = "gitpushy-error";
      errorEl.textContent = this.error;
      wrapper.appendChild(errorEl);
    }

    if (!this.loaded) {
      const loading = document.createElement("div");
      loading.className = "gitpushy-loading";
      loading.textContent = "Loading pull requests…";
      wrapper.appendChild(loading);
      return wrapper;
    }

    if (this.prs.length === 0) {
      const empty = document.createElement("div");
      empty.className = "gitpushy-empty";
      empty.textContent = "No pull requests.";
      wrapper.appendChild(empty);
      return wrapper;
    }

    if (this.config.grouping.mode === "repo") {
      const grouped = this.groupByRepo(this.prs);
      grouped.forEach((group) => {
        const header = document.createElement("div");
        header.className = "gitpushy-repo-header";
        header.textContent = group.repoLabel;
        wrapper.appendChild(header);

        group.items.forEach((pr) => {
          wrapper.appendChild(this.buildRow(pr));
        });
      });
    } else {
      this.prs.forEach((pr) => {
        wrapper.appendChild(this.buildRow(pr));
      });
    }

    return wrapper;
  },

  groupByRepo(prs) {
    const byRepo = new Map();
    prs.forEach((pr) => {
      const label = pr.repoLabel || pr.repo;
      if (!byRepo.has(label)) {
        byRepo.set(label, []);
      }
      byRepo.get(label).push(pr);
    });

    return Array.from(byRepo.entries()).map(([repoLabel, items]) => ({
      repoLabel,
      items
    }));
  },

  buildRow(pr) {
    const row = document.createElement("div");
    row.className = "gitpushy-row";

    const title = this.truncate(pr.title, this.config.display.truncateTitleAt);

    const line = document.createElement("div");
    line.className = "gitpushy-line gitpushy-pill";

    if (this.config.display.showRepoName) {
      const repo = document.createElement("span");
      repo.className = "gitpushy-repo";
      repo.textContent = pr.repoLabel || pr.repo;
      line.appendChild(repo);
    }

    const titleNode = document.createElement("span");
    titleNode.className = "gitpushy-title-text";
    titleNode.textContent = title;
    line.appendChild(titleNode);

    const meta = this.buildMeta(pr);
    if (meta) {
      line.appendChild(meta);
    }

    if (this.config.display.showAuthorAvatar && pr.authorAvatarUrl) {
      const avatar = document.createElement("img");
      avatar.className = "gitpushy-avatar";
      avatar.src = pr.authorAvatarUrl;
      avatar.alt = pr.authorLogin ? `${pr.authorLogin} avatar` : "PR author";
      if (pr.authorLogin) {
        avatar.title = pr.authorLogin;
      }
      line.appendChild(avatar);
    }

    row.appendChild(line);

    return row;
  },

  buildMeta(pr) {
    const hasDiff =
      this.config.display.showAdditionsDeletions &&
      Number.isFinite(pr.additions) &&
      Number.isFinite(pr.deletions);
    const hasFiles =
      this.config.display.showFilesChanged &&
      Number.isFinite(pr.changed_files);
    const hasTime = this.config.display.showTimestamp;

    const container = document.createElement("div");
    container.className = "gitpushy-meta-pills";

    if (hasDiff || hasFiles) {
      const diff = document.createElement("span");
      diff.className = "gitpushy-pill gitpushy-pill-diff";

      if (hasDiff) {
        const additions = document.createElement("span");
        additions.className = "gitpushy-additions";
        additions.textContent = `+${pr.additions}`;

        const deletions = document.createElement("span");
        deletions.className = "gitpushy-deletions";
        deletions.textContent = `-${pr.deletions}`;

        diff.appendChild(additions);
        diff.appendChild(document.createTextNode(" / "));
        diff.appendChild(deletions);
      }

      if (hasFiles) {
        const files = document.createElement("span");
        files.className = "gitpushy-files";
        files.textContent = `${pr.changed_files} files`;

        if (hasDiff) {
          diff.appendChild(document.createTextNode(" • "));
        }
        diff.appendChild(files);
      }

      container.appendChild(diff);
    }

    if (hasTime) {
      const field = this.config.display.timestampField;
      const timestamp = pr[field] || pr.updated_at;
      if (timestamp) {
        const time = document.createElement("span");
        time.className = "gitpushy-pill gitpushy-pill-time";
        time.textContent = this.formatTime(timestamp);
        container.appendChild(time);
      }
    }

    if (!container.childNodes.length) {
      return null;
    }

    return container;
  },

  formatTime(timestamp) {
    if (!moment) {
      return timestamp;
    }

    if (this.config.display.timeFormat === "absolute") {
      return moment(timestamp).format("MMM D, YYYY");
    }

    return moment(timestamp).fromNow();
  },

  truncate(text, limit) {
    if (!limit || text.length <= limit) {
      return text;
    }
    return `${text.slice(0, limit - 1)}…`;
  },

  socketNotificationReceived(notification, payload) {
    if (!payload || payload.instanceId !== this.instanceId) {
      return;
    }

    if (notification === "GITPUSHY_DATA") {
      this.error = null;
      this.loaded = true;
      this.prs = payload.prs || [];
      this.updateDom(300);
      return;
    }

    if (notification === "GITPUSHY_ERROR") {
      this.loaded = true;
      this.error = payload.message || "Error loading pull requests.";
      if (payload.prs) {
        this.prs = payload.prs;
      }
      this.updateDom(300);
    }
  }
});
