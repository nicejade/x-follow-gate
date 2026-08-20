# Follow Gate

[English](README.md) | [中文](README.zh-CN.md)

Local-only Chrome MV3 extension that inspects your signed-in X.com Following list, finds cleanup candidates with configurable strategies, and unfollows them through a conservative, pausable queue.

Personal / trusted-circle tool. Not published to the Chrome Web Store.

## What it does

Follow Gate reuses your existing x.com browser session—no second login and no backend. It syncs Following by scrolling the Following page like a person and observing page-loaded relationship data (it does not page Following GraphQL itself). Candidates are computed locally from scan strategies you enable, then reviewed in Cleanup and run one-at-a-time through a rate-limited queue. All data stays in `chrome.storage.local`.

## Features

- **Local and minimal permissions** — No server, analytics, or remote config. Does not request `cookies`, `<all_urls>`, or `webRequest`.
- **Multi-strategy scan (OR)** — Independently toggle: not following back; non-blue verified; protected/private; very few posts (`statusesCount < 10`); following far exceeds followers (`friendsCount >= 100` and `friendsCount >= followersCount × 1.2`). Whitelist always excludes. Missing fields never match.
- **Safety rate limits** — Default **Safe**: 2–10s between actions, ≤5/hour, ≤20/day, ≤10/session. Balanced and Custom exist; hard floors cannot be bypassed in the UI.
- **Anti-abuse posture** — Randomized scroll pacing; one visible-profile unfollow at a time; Pause / Stop anytime; cooldown on auth or rate-limit-like failures.
- **Reviewable cleanup** — Preview candidates with match reasons; confirm before enqueue; queue stays pausable.

## Usage

```bash
pnpm install && pnpm build
```

1. Open `chrome://extensions`
2. Enable **Developer mode** → **Load unpacked** → select the `dist/` directory
3. Sign in to [x.com](https://x.com) as usual
4. Open the Side Panel from the Follow Gate action

Requires Chrome 114+ and [pnpm](https://pnpm.io/installation) 10+.

**Main flow**

1. **Insight** — Sync Following
2. **Settings** — Choose scan strategies and safety preset (recommended: **Safe**)
3. **Cleanup** — Preview → confirm → queue runs

If anything looks wrong: **Pause**, wait, reload the extension if needed. Never export cookies.

## Development

```bash
pnpm install
pnpm dev          # watch build
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

| Path | Role |
|------|------|
| `src/sidepanel` | Side Panel UI |
| `src/background` | Queue, alarms, storage coordination |
| `src/content` | Following scroll sync and in-page unfollow |
| `src/shared` | Types, scan rules, safety constants |
| `tests/` | Vitest |

PRs: keep changes small and focused; update related tests with behavior changes; explain *why* in the PR description.

## Disclaimer

No automation can guarantee that X will not rate-limit or restrict an account. Follow Gate only reduces risk. Prefer the Safe preset. Never export cookies, headers, or tokens.
