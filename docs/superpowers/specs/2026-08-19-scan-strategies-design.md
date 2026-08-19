# Scan Strategies Design

**Date:** 2026-08-19  
**Status:** Approved for implementation after user review of this spec  
**Scope:** Replace the single hard-coded P0 candidate rule with user-configurable scan strategies in Settings. Five independent rules, OR-combined; whitelist always excludes.

## Problem

Follow Gate currently identifies unfollow candidates with one fixed rule:

```text
followedBy === false AND not whitelisted
```

Users want to broaden cleanup criteria—for example non-blue-verified accounts, protected accounts, low-activity shells, and follow-ratio spam patterns—while keeping the same conservative safety posture (no extra network requests, unknown fields never produce false positives).

## Goals

1. Add **five independently toggleable scan strategies** in Settings.
2. **OR logic:** a user enters the cleanup list when they match **any enabled** strategy and are not whitelisted.
3. **Default unchanged:** only “not following back” is enabled on upgrade; behavior matches P0 until the user opts in.
4. **Conservative unknown handling:** missing or unparseable fields yield `null` and never match a strategy (same principle as `followedBy === null`).
5. Parse new user attributes from **existing Following-page payloads only**—no profile visits or extra GraphQL calls.
6. Show **match reasons** on the Cleanup candidate list.

## Non-goals

- “Inactive within 7 days” or any rule requiring last-tweet timestamps (not reliably present in Following sync payloads).
- Per-strategy numeric thresholds in Settings UI (tweet count and follow-ratio thresholds are fixed constants in v1).
- Keyword / bio blacklist rules (P2).
- Changing unfollow queue intervals, caps, or sync scroll budget.

## User-confirmed decisions

| Topic | Decision |
|-------|----------|
| Combination logic | **OR** across enabled strategies |
| Strategy 2 | **Non-blue verified only** (no inactivity gate) |
| Strategy 4 threshold | `statusesCount < 10` |
| Strategy 5 threshold | `friendsCount >= 100` **and** `friendsCount >= followersCount × 1.2` |
| Whitelist | Always excludes, regardless of matched strategies |

## Design

### 1. Scan strategies

Each strategy is a pure predicate over `FollowingUser`. Settings stores a boolean per strategy.

| ID | Settings key | UI label | Match condition |
|----|--------------|----------|-----------------|
| `not-following-back` | `notFollowingBack` | 对方未回关 | `followedBy === false` |
| `non-blue-verified` | `nonBlueVerified` | 对方非蓝标 | `isBlueVerified === false` |
| `protected` | `protected` | 对方已锁定 / 私密 | `protected === true` |
| `low-tweet-count` | `lowTweetCount` | 推文极少（< 10） | `statusesCount !== null && statusesCount < 10` |
| `follow-ratio` | `followRatio` | 关注远大于粉丝 | `friendsCount !== null && followersCount !== null && friendsCount >= 100 && friendsCount >= followersCount * 1.2` |

**Candidate selection:**

```text
candidate(user) =
  NOT whitelisted(user)
  AND EXISTS enabled strategy S WHERE S.matches(user)
```

If **no strategy is enabled**, the candidate list is empty (user must enable at least one rule to get candidates).

**Important behavioral note:** enabling “non-blue verified” alone will include **mutual** non-blue accounts because OR logic does not require “not following back.” This is intentional per user choice.

### 2. Unknown-value semantics

Every new attribute uses a tri-state or nullable model:

| Field | Type | Unknown | Matches strategy when |
|-------|------|---------|----------------------|
| `followedBy` | `true \| false \| null` | `null` | only `false` for not-following-back |
| `isBlueVerified` | `boolean \| null` | `null` | only `false` for non-blue-verified |
| `protected` | `boolean \| null` | `null` | only `true` for protected |
| `statusesCount` | `number \| null` | `null` | numeric `< 10` for low-tweet-count |
| `friendsCount` | `number \| null` | `null` | used only when both counts are non-null for follow-ratio |
| `followersCount` | `number \| null` | `null` | same |

Parser rules (aligned with `readFollowedBy`):

- Non-boolean values for booleans → `null`.
- Non-finite or negative integers for counts → `null`.
- When merging duplicate users during sync, **never downgrade** a known value to `null`; fill gaps only (`existing ?? incoming`).

### 3. Data model

#### `FollowingUser` (extended)

```ts
export interface FollowingUser {
  userId: string;
  handle: string;
  name: string;
  avatarUrl: string | null;
  followedBy: RelationshipState;
  isBlueVerified: boolean | null;
  protected: boolean | null;
  statusesCount: number | null;
  friendsCount: number | null;
  followersCount: number | null;
  syncedAt: number;
}
```

#### `ScanStrategies` + `Settings`

```ts
export interface ScanStrategies {
  notFollowingBack: boolean;
  nonBlueVerified: boolean;
  protected: boolean;
  lowTweetCount: boolean;
  followRatio: boolean;
}

export interface Settings {
  // existing fields…
  scanStrategies: ScanStrategies;
}
```

**Defaults:**

```ts
scanStrategies: {
  notFollowingBack: true,
  nonBlueVerified: false,
  protected: false,
  lowTweetCount: false,
  followRatio: false,
}
```

**Constants (not user-editable in v1):**

```ts
export const LOW_TWEET_COUNT_THRESHOLD = 10;
export const FOLLOW_RATIO_MIN_FOLLOWING = 100;
export const FOLLOW_RATIO_MULTIPLIER = 1.2;
```

#### State version

- Bump `STATE_VERSION` from `2` → `3`.
- Migration: hydrate missing `scanStrategies` with defaults above.
- Existing `following` entries gain new fields as `null` until the next sync repopulates them from page payloads.

### 4. Parser changes (`x-data-adapter.ts`)

Extend structural extraction to read from the same user objects already walked today:

| Field | Primary sources | Fallback |
|-------|-----------------|----------|
| `isBlueVerified` | `is_blue_verified` | — |
| `protected` | `legacy.protected` | top-level `protected` |
| `statusesCount` | `legacy.statuses_count` | — |
| `friendsCount` | `legacy.friends_count` | — |
| `followersCount` | `legacy.followers_count` | — |

Add unit tests with synthetic fixtures (hand-crafted, same provenance as existing fixture). Real capture re-verification remains a manual checklist item before release.

Also update `following-batch.ts` to accept and sanitize the new fields on worker ingest paths.

### 5. Rule engine (`rules.ts`)

Replace the single-rule `selectCandidates` with:

```ts
function matchReasons(user: FollowingUser, strategies: ScanStrategies): ScanStrategyId[];

function selectCandidates(
  users: FollowingUser[],
  whitelist: WhitelistEntry[],
  strategies: ScanStrategies,
): FollowingUser[];
```

- `matchReasons` returns all enabled strategies that match (may be multiple).
- `selectCandidates` filters whitelisted users, then keeps users where `matchReasons` is non-empty.
- Preserve input order (Following list order).

Export human-readable reason labels for the side panel (e.g. `未回关`, `非蓝标`, `已锁定`, `推文<10`, `关注/粉丝比`).

Wire `recomputeCandidates` in `store.ts` and all call sites (`CleanupView`, queue start preview, tests) to pass `state.settings.scanStrategies`.

### 6. UI

#### Settings — new section「扫描策略」

Place above the whitelist block. Five checkboxes with one-line descriptions. Footer copy:

> 满足任一已勾选规则即进入待清理列表；白名单始终排除。

Rules 4 and 5 show their fixed thresholds inline (no numeric inputs in v1). Persist via existing draft +「保存设置」→ `SETTINGS_UPDATE` → `clampSettings`.

`clampSettings` must ensure at least the object shape is valid; it does **not** force any strategy to stay enabled (all-off is allowed but yields zero candidates).

#### Cleanup

- Replace static rule summary (`未回关 · 白名单已排除`) with dynamic text, e.g. `已启用 3 条策略 · 白名单已排除`.
- Each candidate row shows small reason tag(s) from `matchReasons`.
- Selection / preview / queue start behavior unchanged.

#### Insight

- Rename or relabel “非互关候选” to **待清理候选** (count uses current `scanStrategies`).
- Optional v1: per-strategy hit counts in metrics; not required for ship.

### 7. Error handling & edge cases

| Case | Behavior |
|------|----------|
| All strategies disabled | Zero candidates; Cleanup CTA disabled |
| User enables strategies 2–5 before re-sync | Those rules match nobody until new fields populate |
| `followersCount === 0` with high `friendsCount` | Follow-ratio matches when `friendsCount >= 100` (ratio infinite) |
| Whitelisted user matches multiple strategies | Never a candidate |
| Queue running with stale strategies | Queue items are snapshot at start; changing settings mid-run does not mutate in-flight items (existing behavior) |

### 8. Testing

**Unit (`rules.test.ts`):**

- Each strategy: positive, negative, unknown (`null`) cases.
- OR combinations: single enabled, multiple enabled, all disabled.
- Whitelist veto.
- Follow-ratio boundary: 99 following (no match), 100 following at exact 1.2×, below ratio.

**Parser (`x-data-adapter.test.ts`, `following-batch.test.ts`):**

- Field extraction from modern + legacy shapes.
- Merge does not downgrade known values.

**Store migration:**

- Legacy state v2 hydrates with default `scanStrategies` (only not-following-back true).
- `recomputeCandidates` respects strategies.

**Side panel (optional smoke):**

- Settings checkboxes persist.
- Cleanup shows reason tags.

### 9. Manual verification checklist

Before release, re-verify parser fields against one redacted real Following response capture:

- [ ] `is_blue_verified` present and boolean
- [ ] `legacy.protected` present
- [ ] `legacy.statuses_count` present
- [ ] `legacy.friends_count` / `followers_count` present

## Architecture diagram

```text
Following page payload (passive)
        │
        ▼
 x-data-adapter ──► FollowingUser (+ new fields, null-safe)
        │
        ▼
 chrome.storage.local.following
        │
        ▼
 selectCandidates(users, whitelist, scanStrategies)
   │ matchReasons per user
   ▼
 Cleanup preview / queue start
        ▲
 Settings.scanStrategies (OR toggles)
```

## Rollout

1. Ship parser + model + migration (strategies default to P0-only).
2. Ship Settings UI + Cleanup reason tags.
3. User re-syncs Following to populate new fields for strategies 2–5.
4. User enables additional strategies as desired.

No change to Safe preset intervals or unfollow caps.
