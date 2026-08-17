# Sync Scroll Budget Design

**Date:** 2026-08-17  
**Status:** Approved for implementation after user review of this spec  
**Scope:** Raise Following sync throughput for 1000+ accounts by replacing step/time budgets with a configurable person count, and randomize inter-scroll delays to 1–15s.

## Problem

Users with 1000+ follows cannot finish a sync in one practical session. The content scroll controller currently ends a round when either:

- active scroll time reaches **8 minutes**, or
- forward steps reach **120**.

Those caps were intended as anti-automation floors, but they force many “Continue” rounds for large lists. Separately, step pauses are fixed at 1.5–4s (occasionally 6–12s), which is slower than the user now wants.

Observed “~50 per round” in manual testing is an emergent effect of step size + budgets + X paging, not a dedicated `50` constant.

## Goals

1. Default sync target: **1000 people per round**.
2. Target is **user-configurable** in Settings, clamped to **100–5000**.
3. Inter-scroll delay: **uniform random in [1s, 15s]** every step.
4. Keep existing safety stops: list end / no-growth stall, hidden tab, auth, manual pause, queue mutual exclusion.
5. Minimal surface area: extend existing `Settings` + scroll controller; do not redesign sync architecture.

## Non-goals

- Changing unfollow queue intervals/caps.
- Changing Following batch message chunk sizes (`maxUsers` 500).
- Guaranteeing X will return exactly N users; the target is a **discovered-count stop**, not a request quota.
- Removing human-like scroll step distances or reverse micro-scrolls.

## Design

### 1. Settings model

Add one field to `Settings`:

```ts
syncTargetCount: number; // people to discover per scroll round
```

Defaults and clamps:

| Field | Default | Min | Max |
|-------|---------|-----|-----|
| `syncTargetCount` | `1000` | `100` | `5000` |

- Persist via existing `SETTINGS_UPDATE` → `clampSettings` → `chrome.storage.local`.
- Missing/legacy state: hydrate with default `1000` (no `STATE_VERSION` bump required if `hydrateSection` + `clampSettings` always fill the field).
- Independent of safety preset (`safe` / `balanced` / `custom`): always editable; presets do not overwrite it.

### 2. Settings UI

In `SettingsView`, add a numeric control:

- Label: **每轮同步人数**
- Helper: `100–5000，默认 1000`
- Bound into the existing draft +「保存设置」flow (`clampSettings` on save).

No new message types for settings.

### 3. Scroll controller stop condition

Replace round budgets that currently drive `pause("budget")`:

| Remove / stop using as round end | Keep |
|----------------------------------|------|
| `maxRoundMs` (8 min) as stop | `maxNoGrowthSteps` → `completed` / `stalled` |
| `maxSteps` (120) as stop | hidden / user / auth pauses |
| dual short/long pause bands | reverse probability & step ratios |

New stop:

- After each forward step’s growth judgment (same timing as today), if `discoveredCount - startDiscoveredCount >= syncTargetCount`, pause with reason **`budget`** (reuse existing reason + Insight copy: “本轮同步已达…上限”).
- Prefer measuring against controller `discoveredCount` (union of accepted batches), already reported in `SCROLL_STATUS`.

`maxRoundMs` / `maxSteps` may remain as defensive absolute ceilings only if needed for pathological loops; if kept, set them high enough that a 5000-person target at 1–15s pauses is reachable (or remove them from the stop path entirely). Spec preference: **remove them from the stop path** so the user-facing budget is solely the person count.

### 4. Inter-scroll delay

`scheduleStep()` samples once:

```text
delayMs = randomIntInclusive(1000, 15000)
```

Remove `longPauseProbability` / short vs long pause bands from the default path. Tests assert delays fall in `[1000, 15000]` inclusive.

### 5. Wiring settings into the content controller

Today `SCROLL_SESSION_START` carries no payload and `isolated.ts` creates the controller with default `SCROLL_LIMITS`.

Required flow:

1. Worker `startSync` (and any re-delivery of start) reads `state.settings.syncTargetCount` (clamped).
2. Send `{ type: "SCROLL_SESSION_START", syncTargetCount }` (additive field; keep type name).
3. Content calls the cached controller as `start(syncTargetCount)`. The controller clamps and snapshots this value into the new round, so a changed setting applies even when the same content script remains loaded.
4. If start arrives without the field (old build / race): fall back to **1000**.

Mid-round settings changes do not retarget the live controller; they apply on the next `SCROLL_SESSION_START`.

### 6. Continue after budget

Existing behavior remains: after `budget`, the user starts a new sync. Each new round aims for `syncTargetCount` additional discoveries relative to that round's baseline.

For large lists the user wants “about 1000 more per session click,” not “stop forever once total following map ≥ 1000.”

**Chosen rule:** stop when the round has **newly discovered** at least `syncTargetCount` accounts since `start()`:

```text
round.discoveredCount - round.startDiscoveredCount >= syncTargetCount
```

If the list stalls before that, existing no-growth completion still applies.

### 7. Testing

Update / add:

- `tests/content/scroll-controller.test.ts` — delay band 1–15s; person-budget stop; no 120-step / 8-min early stop; continue after budget.
- `tests/shared/safety.test.ts` — clamp `syncTargetCount` to 100–5000; default 1000.
- `tests/sidepanel/App.test.tsx` (or settings-focused) — control present; save sends clamped value.
- `tests/background/sync-coordinator.test.ts` / messages — `SCROLL_SESSION_START` includes `syncTargetCount`.
- `tests/content/isolated.test.ts` — start applies target into controller limits (if covered).

### 8. Manual check

- Set target 1000, sync a large following list: round pauses near +1000 discoveries without needing dozens of continues solely due to 120 steps.
- Change target to 100 / 5000, save, new sync respects value.
- Observe irregular waits roughly 1–15s between scrolls.
- Hidden tab / stall / queue exclusion still work.

## Error handling

- Invalid stored `syncTargetCount` → clamp on hydrate/save.
- Oversized start payload field ignored via clamp in content/worker.
- No new circuit-breaker codes.

## Open decisions (resolved)

| Question | Resolution |
|----------|------------|
| Configurable range | 100–5000 |
| Default | 1000 |
| Delay | Uniform random 1–15s |
| Budget meaning | New discoveries this round ≥ target |
| Preset coupling | Independent of unfollow safety preset |
