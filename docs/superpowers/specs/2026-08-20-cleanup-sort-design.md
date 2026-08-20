# Cleanup Candidate Sort Design

**Date:** 2026-08-20  
**Status:** Approved in conversation; implemented in the same session  
**Scope:** Add sort controls to the Cleanup candidate list, using the five scan strategies as keys. Display order is also unfollow queue order.

## Problem

The Cleanup list is currently shown in Following-sync insertion order. Once several scan strategies are enabled, mixed match reasons make it hard to work through one concern at a time (not following back first, then non-blue, and so on).

## Goals

1. Sort the Cleanup list by scan-strategy match, with a default cascade and an optional primary key.
2. Keep queue start order identical to the on-screen order of checked rows.
3. Do not persist sort preference; do not change candidate selection, scan predicates, or Settings.

## User-confirmed decisions

| Topic | Decision |
|-------|----------|
| Interaction | Default cascade plus a picker that promotes one strategy |
| Queue | Visual order of checked rows is `QUEUE_START.userIds` |
| UI | Native `<select>` above the list, below the start CTA |
| Labels | Short `SCAN_STRATEGY_LABELS` plus default「策略优先级」 |
| Options | Default + currently enabled strategies only |
| Persistence | Session-only React state |
| Ties | Stable: preserve `selectCandidates` input order |

## Sort rules

Fixed cascade:

1. `not-following-back` 未回关
2. `non-blue-verified` 非蓝标
3. `protected` 已锁定
4. `low-tweet-count` 推文&lt;10
5. `follow-ratio` 关注/粉丝比

Default `priority`: lexicographic comparison on those keys. A match ranks before a non-match. A user may match several enabled strategies; earlier keys weigh more.

Picking one strategy: that id moves to the front, remaining keys keep cascade order. Example, pick 非蓝标 → non-blue-verified, not-following-back, protected, low-tweet-count, follow-ratio.

Disabled strategies never appear in `matchReasons`, so they are no-ops as sort keys. If the current picker value becomes disabled, reset to `priority`.

Changing sort must not reset row checkboxes.

## Architecture

- Pure `sortCandidates(users, strategies, sortBy)` in `src/shared/rules.ts`.
- `CleanupView` selects, then sorts; start queue maps sorted checked ids.
- No `STATE_VERSION` bump, no storage, no extra network.

## Tests

- `tests/shared/rules.test.ts`: default cascade, promoted key, multi-match, stable ties, disabled keys ignored.
- `tests/sidepanel/App.test.tsx`: list reorder on change; `QUEUE_START.userIds` matches visual checked order; picker omits disabled strategies.
