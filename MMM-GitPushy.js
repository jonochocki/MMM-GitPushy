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
      singleLine: true,
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

    if (this.config.display.singleLine) {
      const line = document.createElement("div");
      line.className = "gitpushy-line";

      const leadingParts = [];
      if (this.config.display.showRepoName) {
        leadingParts.push(pr.repoLabel || pr.repo);
      }
      leadingParts.push(title);

      const leading = document.createElement("span");
      leading.className = "gitpushy-leading";
      leading.textContent = leadingParts.join(" — ");
      line.appendChild(leading);

      const meta = this.buildMeta(pr);
      if (meta) {
        line.appendChild(meta);
      }

      row.appendChild(line);
      return row;
    }

    const titleLine = document.createElement("div");
    titleLine.className = "gitpushy-title";
    const titleParts = [];
    if (this.config.display.showRepoName) {
      titleParts.push(pr.repoLabel || pr.repo);
    }
    titleParts.push(title);
    titleLine.textContent = titleParts.join(" — ");
    row.appendChild(titleLine);

    const meta = this.buildMeta(pr);
    if (meta) {
      row.appendChild(meta);
    }

    return row;
  },

  buildMeta(pr) {
    const metaParts = [];

    if (
      this.config.display.showAdditionsDeletions &&
      Number.isFinite(pr.additions) &&
      Number.isFinite(pr.deletions)
    ) {
      const additions = document.createElement("span");
      additions.className = "gitpushy-additions";
      additions.textContent = `+${pr.additions}`;

      const deletions = document.createElement("span");
      deletions.className = "gitpushy-deletions";
      deletions.textContent = `-${pr.deletions}`;

      const container = document.createElement("span");
      container.className = "gitpushy-diff";
      container.appendChild(additions);
      container.appendChild(document.createTextNode(" / "));
      container.appendChild(deletions);
      metaParts.push(container);
    }

    if (
      this.config.display.showFilesChanged &&
      Number.isFinite(pr.changed_files)
    ) {
      const files = document.createElement("span");
      files.className = "gitpushy-files";
      files.textContent = `${pr.changed_files} files`;
      metaParts.push(files);
    }

    if (this.config.display.showTimestamp) {
      const field = this.config.display.timestampField;
      const timestamp = pr[field] || pr.updated_at;
      if (timestamp) {
        const time = document.createElement("span");
        time.className = "gitpushy-time";
        time.textContent = this.formatTime(timestamp);
        metaParts.push(time);
      }
    }

    if (metaParts.length === 0) {
      return null;
    }

    const meta = document.createElement("div");
    meta.className = "gitpushy-meta";

    metaParts.forEach((part, index) => {
      if (index > 0) {
        meta.appendChild(document.createTextNode(" • "));
      }
      meta.appendChild(part);
    });

    if (this.config.display.singleLine) {
      const wrapper = document.createElement("span");
      wrapper.className = "gitpushy-meta-inline";
      wrapper.appendChild(document.createTextNode(" ("));
      wrapper.appendChild(meta);
      wrapper.appendChild(document.createTextNode(")"));
      return wrapper;
    }

    return meta;
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
