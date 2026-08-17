# Follow Gate

A local-only Chrome MV3 extension that inspects an already signed-in X.com Following list, finds accounts that do not follow you back, and unfollows them through a conservative, pausable queue.

This is a personal / trusted-circle tool. It is not published to the Chrome Web Store.

## Safety warning

No automation can guarantee that X will not rate-limit or restrict an account. Follow Gate only reduces risk: it reuses the existing browser session, scrolls like a person, never pages Following GraphQL itself, and writes at most one unfollow at a time under Safe defaults.

**Recommended preset: Safe** (90–150s interval, ≤5/hour, ≤20/day, ≤10/session).

If anything looks wrong: **Pause**, wait, reload the extension. Never export cookies.

## Install (unpacked)

```bash
pnpm install
pnpm build
```

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** and select the `dist/` directory
4. Sign in to [x.com](https://x.com) as usual
5. Click the Follow Gate action to open the Side Panel

Requires Chrome 114+. Requires [pnpm](https://pnpm.io/installation) 10+.

## How it works

1. **Insight** — sync Following by opening `/following` and scrolling progressively. Relationship data is observed from page-loaded responses.
2. **Cleanup** — P0 rule: `followedBy === false` and not on the whitelist. Preview, then confirm.
3. **Queue** — one visible profile, two UI clicks (Following → confirm), then a full interval before the next action.

Data stays in `chrome.storage.local`. There is no server, analytics, or remote config.

## Permissions

| Permission                                      | Why                                                           |
| ----------------------------------------------- | ------------------------------------------------------------- |
| `storage`                                       | Persist following map, whitelist, queue, settings, audit log  |
| `alarms`                                        | Schedule the next unfollow after `nextAt` (MV3 workers sleep) |
| `sidePanel`                                     | Main UI                                                       |
| `tabs`                                          | Focus/reuse an existing X tab; never create extra write tabs  |
| `scripting`                                     | Declared for MV3 content injection support                    |
| Host `https://x.com/*`, `https://twitter.com/*` | Read the Following page and click visible profile controls    |

The extension does **not** request `cookies`, `<all_urls>`, or `webRequest`.

## Scripts

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
pnpm build
pnpm dev          # watch build
```

## Recovery

1. Click **暂停** or **停止** in the Side Panel
2. Wait out any cooldown (default 60 minutes after 401/403/429-equivalent UI failures)
3. Reload the extension from `chrome://extensions`
4. Do not export cookies, headers, or tokens

## Out of scope (P0)

Inactivity / zombie detection, keyword blacklist, CLI, cloud sync, Chrome Web Store, multi-account parallelism.
