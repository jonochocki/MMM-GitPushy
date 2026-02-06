# MMM-GitPushy

MagicMirror module for displaying open GitHub pull requests.

## Features (v1 defaults)
- No owner/org displayed in the UI.
- Read-only PR list (no review/approval state).
- Draft PRs are included by default (configurable).
- One-line rows optimized for bottom bar placement.

## Installation
1. Copy this folder into `MagicMirror/modules/MMM-GitPushy`.
2. Install dependencies:

```bash
cd MagicMirror/modules/MMM-GitPushy
npm install
```

3. Provide a GitHub token:
   - Either set `auth.token` directly in the module config, or
   - Set a GitHub token env var (defaults to `GITHUB_TOKEN`).
   - For private repos, the token must have access to the repo (typically `repo` scope for classic tokens).

## Minimal Config

```js
{
  module: "MMM-GitPushy",
  position: "bottom_bar",
  config: {
    auth: { token: "ghp_XXXXXXXXXXXXXXXXXXXX" },
    targets: [
      { owner: "your-org", repo: "chicle-menu-builder", displayName: "Chicle" }
    ]
  }
}
```

## Full Config (only include what you’re changing)

```js
config: {
  auth: {
    token: "ghp_XXXXXXXXXXXXXXXXXXXX",
    tokenEnvVar: "GITHUB_TOKEN",
    apiBaseUrl: "https://api.github.com"
  },

  targets: [
    {
      owner: "your-org",
      repo: "chicle-menu-builder",
      displayName: "Chicle",

      // Branch filtering (PR base branch)
      baseBranchesMode: "defaultOnly", // "defaultOnly" | "all" | "list"
      baseBranches: ["main", "develop"],

      // Optional: avoid repo metadata call if you want
      defaultBranchOverride: null
    }
  ],

  query: {
    state: "open",
    includeDrafts: true              // default true; set false to hide drafts
  },

  display: {
    // Defaults optimized for bottom bar / one-line rows
    showRepoName: true,              // shows displayName if present, else repo slug
    showTimestamp: true,
    timestampField: "updated_at",    // "updated_at" | "created_at"
    timeFormat: "relative",          // "relative" | "absolute"
    showAdditionsDeletions: true,    // green + / red -
    showFilesChanged: true,
    showAuthorAvatar: true,          // show PR author avatar
    debugAuthorAvatar: false,        // console warning when avatar data is missing
    truncateTitleAt: 90
  },

  grouping: {
    mode: "none"                     // "none" | "repo"
  },

  limits: {
    maxTotal: 20,
    maxPerRepo: 10
  },

  refresh: {
    updateIntervalMs: 300000,
    listCacheTtlMs: null,            // defaults to updateIntervalMs - 10s
    detailsCacheTtlMs: null,         // defaults to updateIntervalMs
    backoffOnRateLimit: true
  },

  alerts: {
    showOnAuthError: true
  }
}
```

## Data Fields Used
Per PR (enough for the default UI):
- `repoLabel` (displayName or repo)
- `number`
- `title`
- `html_url` (optional; future click-to-open)
- `updated_at` / `created_at`
- `state`
- `additions`, `deletions`, `changed_files`
- `authorLogin`, `authorAvatarUrl`
- `draft` (to filter if includeDrafts is false)
- `base.ref` (for branch filtering)

## Implementation Notes
- All GitHub calls are done in `node_helper.js` so tokens never reach the browser.
- PRs are filtered by base branch (no branch scanning).
- Per-repo caching uses ETags to reduce rate usage; list and details TTLs are configurable.
- Socket payloads include `instanceId` so multiple module instances can coexist.

## Troubleshooting
- If you see `Missing GitHub token`, confirm the env var is set in the same shell/user context as MagicMirror.
- If you hit a rate limit, the module will pause until the reset time (when backoff is enabled).
