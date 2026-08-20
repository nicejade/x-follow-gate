# README Optimization Design

**Date:** 2026-08-20  
**Status:** Approved for documentation after user review of this spec  
**Scope:** Rewrite project README for clarity and best practices; dual-language; no product code changes  
**Audience:** Personal / trusted-circle users and occasional contributors

## Problem

The current `README.md` mixes product pitch, deep permission tables, recovery runbooks, out-of-scope lists, and script inventories. It under-emphasizes what the project does and what makes it distinctive (multi-strategy scan, safety floors, anti-abuse posture), and it has no Chinese edition.

## Goals

1. Cover four required topics clearly: **purpose**, **features**, **usage**, **development**.
2. Ship **two full documents**: English primary + Chinese mirror.
3. Remove content that does not serve those four topics.
4. Keep feature claims aligned with **implemented** behavior only.

## Non-goals

- Screenshots, GIFs, or visual placeholders
- New `CONTRIBUTING.md`
- Chrome Web Store packaging or marketing site
- Changing extension code, settings copy, or docs under `docs/superpowers/plans/`
- Linking a long list of design/plan docs from the README (default: no deep links)

## Decisions

| Topic | Decision |
|-------|----------|
| Languages | `README.md` (English) + `README.zh-CN.md` (Chinese); top mutual links |
| Structure | Product-style four sections + short disclaimer |
| Contributing depth | Short section inside each README only |
| Trim level | Drop permissions table, Recovery steps, Out of scope, full Scripts list, long “How it works” |
| Visuals | None |
| Design doc links | Optional one-liner only; **default: omit** |

## Document structure (both languages, mirrored)

1. **Title + one-liner** — what it is and who it is for  
2. **What it does** — purpose (2–4 sentences)  
3. **Features** — bullets grounded in real behavior  
4. **Usage** — unpacked install + Side Panel main flow  
5. **Development** — env, common scripts, layout, PR expectations  
6. **Disclaimer** — 1–2 sentences on rate-limit risk; Pause guidance; never export cookies  

Top of each file: language switcher (`English` / `中文`).

## Section content

### What it does

- Local-only Chrome MV3 extension for an already signed-in X.com session.
- Syncs Following by human-like scrolling on the Following page; observes page-loaded relationship data (extension does not page Following GraphQL itself).
- Builds unfollow candidates from configurable scan strategies; preview → confirm → conservative queue.
- Data stays in `chrome.storage.local`. No server, analytics, or remote config.
- Personal / trusted-circle tool; not published to the Chrome Web Store.

### Features (must match implementation)

1. **Local and minimal permissions** — no backend; does not request `cookies`, `<all_urls>`, or `webRequest`.
2. **Multi-strategy scan (OR)** — independently toggleable: not following back; non-blue verified; protected; low tweet count (`statusesCount < 10`); follow-ratio spam pattern (`friendsCount >= 100` and `friendsCount >= followersCount × 1.2`). Whitelist always excludes. Missing/unparseable fields never match.
3. **Safety rate limits** — default **Safe** (2–10s interval between actions, ≤5/hour, ≤20/day, ≤10/session; verified against `PRESET_LIMITS.safe` in `src/shared/safety.ts`). Balanced / Custom exist; hard floors cannot be bypassed by UI.
4. **Anti-abuse posture** — randomized scroll pacing; one unfollow at a time via visible profile UI; Pause / Stop; cooldown on auth / rate-limit-like failures.
5. **Reviewable cleanup** — candidate preview with match reasons; enqueue only after confirm; queue always pausable.

Do **not** claim that X will never rate-limit or restrict the account. Phrase as risk reduction only.

### Usage

Install:

```bash
pnpm install && pnpm build
```

1. Open `chrome://extensions`
2. Enable Developer mode → Load unpacked → select `dist/`
3. Sign in to x.com as usual → open Side Panel via the extension action
4. Requirements: Chrome 114+, pnpm 10+

Main flow:

1. **Insight** — Sync Following  
2. **Settings** — choose scan strategies and safety preset (recommend Safe)  
3. **Cleanup** — preview → confirm → queue; if anything looks wrong, Pause; never export cookies  

### Development

- Prerequisites: Node + pnpm 10+; `pnpm install`
- Common scripts: `pnpm dev`, `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build`
- Layout:
  - `src/sidepanel` — UI
  - `src/background` — queue / alarms / storage
  - `src/content` — scroll sync and in-page unfollow
  - `src/shared` — types, rules, safety constants
  - `tests/` — Vitest
- PR expectations: small focused changes; update related tests with behavior changes; explain *why* in the PR description

### Disclaimer

Any automation can still trigger X rate limits or account restrictions. Follow Gate only reduces risk. Prefer Safe. On trouble: Pause, wait, reload the extension if needed. Never export cookies.

## Explicit removals (vs current README)

| Remove | Rationale |
|--------|-----------|
| Permissions table | Implementation detail; not needed for install/use |
| Full Scripts list | Keep only the five common commands under Development |
| Recovery four-step runbook | Fold into one Pause guidance line |
| Out of scope (P0) list | Not required for the four target sections |
| Long “How it works” narrative | Absorb into Features + Usage |

## Maintenance rules

- English and Chinese must keep the **same section order and bullet inventory**.
- When product behavior changes (strategies, Safe numbers, modules), update **both** READMEs in the same change.
- Feature wording must stay consistent with Settings UI and `src/shared` safety/strategy constants.

## Implementation notes (for the follow-up plan)

1. Replace `README.md` with the English document per this spec.  
2. Add `README.zh-CN.md` as a full Chinese mirror.  
3. No other files required for this scope.  
4. Verify Safe interval/cap numbers and strategy labels against current code before publishing wording.  
5. Do not add screenshots or CONTRIBUTING.md.

## Success criteria

- A new reader can answer in under two minutes: what it is, why it is cautious, how to install/use, how to hack on it.
- No permissions table, Recovery section, or Out of scope section remains.
- `README.md` and `README.zh-CN.md` are structurally mirrored and cross-linked.
