# Scan Strategies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hard-coded P0 candidate rule with five user-toggleable scan strategies (OR-combined), parsed from existing Following-page payloads, shown in Settings and Cleanup with match-reason tags.

**Architecture:** Extend `FollowingUser` with nullable profile fields parsed in `x-data-adapter.ts`; add `Settings.scanStrategies`; implement pure predicates in `rules.ts` (`matchReasons` + updated `selectCandidates`); wire `recomputeCandidates`, queue, and side panel to pass strategies. Unknown fields stay `null` and never match.

**Tech Stack:** TypeScript 6, React 19, Tailwind CSS 4, Chrome MV3 messaging/storage, Vitest, Testing Library.

**Spec:** `docs/superpowers/specs/2026-08-19-scan-strategies-design.md`

## Global Constraints

- OR logic across enabled strategies; whitelist always excludes.
- Default strategies: only `notFollowingBack: true`; all others `false`.
- Unknown/null fields never produce a match (same as `followedBy === null`).
- Fixed thresholds: `statusesCount < 10`; `friendsCount >= 100 && friendsCount >= followersCount * 1.2`.
- No extra network requests or profile visits; parse only existing Following payloads.
- Bump `STATE_VERSION` from `2` to `3`; hydrate missing `scanStrategies` with defaults.
- Do not change unfollow intervals, caps, or sync scroll budget.
- Add no dependencies.

---

## File map

| File | Responsibility |
|------|----------------|
| `src/shared/types.ts` | `ScanStrategies`, extended `FollowingUser`, extended `Settings` |
| `src/shared/defaults.ts` | `STATE_VERSION = 3`, default `scanStrategies` |
| `src/shared/rules.ts` | Predicates, `matchReasons`, `selectCandidates`, labels |
| `src/shared/safety.ts` | `clampScanStrategies` called from `clampSettings` |
| `src/content/x-data-adapter.ts` | Parse 5 new fields; merge without downgrade |
| `src/shared/following-batch.ts` | Sanitize new fields at trust boundary |
| `src/background/store.ts` | Migration, `recomputeCandidates`, `isFollowingUser` |
| `src/background/queue.ts` | Pass `state.settings.scanStrategies` to `selectCandidates` |
| `src/sidepanel/views/SettingsView.tsx` | Scan strategy checkboxes |
| `src/sidepanel/views/CleanupView.tsx` | Dynamic summary + reason tags |
| `src/sidepanel/lib/metrics.ts` | `cleanupCandidateCount` helper |
| `src/sidepanel/views/InsightView.tsx` | Relabel metric to 待清理候选 |
| `tests/shared/rules.test.ts` | Full rule-engine coverage |
| `tests/content/x-data-adapter.test.ts` | Parser field tests |
| `tests/shared/following-batch.test.ts` | Batch sanitization tests |
| `tests/background/store.test.ts` | Migration + recompute |
| `tests/sidepanel/App.test.tsx` | Settings + Cleanup smoke |

---

### Task 1: Types, defaults, and clamping

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/shared/defaults.ts`
- Modify: `src/shared/safety.ts`
- Modify: `tests/shared/safety.test.ts`

**Interfaces:**
- Produces: `ScanStrategyId`, `ScanStrategies`, extended `FollowingUser`, extended `Settings`
- Produces: `DEFAULT_SCAN_STRATEGIES`, `STATE_VERSION = 3`
- Produces: `LOW_TWEET_COUNT_THRESHOLD = 10`, `FOLLOW_RATIO_MIN_FOLLOWING = 100`, `FOLLOW_RATIO_MULTIPLIER = 1.2`
- Produces: `clampScanStrategies(value: Partial<ScanStrategies>): ScanStrategies`

- [ ] **Step 1: Write failing safety/clamp tests**

Add to `tests/shared/safety.test.ts`:

```ts
import { DEFAULT_SCAN_STRATEGIES } from "@/shared/defaults";

it("defaults scan strategies to P0-only not-following-back", () => {
  expect(createDefaultSettings().scanStrategies).toEqual(DEFAULT_SCAN_STRATEGIES);
});

it("normalizes scan strategy booleans on clamp", () => {
  const clamped = clampSettings({
    ...settings(),
    scanStrategies: {
      notFollowingBack: 1 as unknown as boolean,
      nonBlueVerified: "yes" as unknown as boolean,
      protected: false,
      lowTweetCount: undefined as unknown as boolean,
      followRatio: true,
    },
  });

  expect(clamped.scanStrategies).toEqual({
    notFollowingBack: true,
    nonBlueVerified: false,
    protected: false,
    lowTweetCount: false,
    followRatio: true,
  });
});
```

Update the test `settings()` factory to include `scanStrategies: { ...DEFAULT_SCAN_STRATEGIES }`.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
pnpm vitest run tests/shared/safety.test.ts
```

Expected: TypeScript errors — `ScanStrategies` and `scanStrategies` do not exist.

- [ ] **Step 3: Implement types and clamp**

In `src/shared/types.ts`, add:

```ts
export type ScanStrategyId =
  | "not-following-back"
  | "non-blue-verified"
  | "protected"
  | "low-tweet-count"
  | "follow-ratio";

export interface ScanStrategies {
  notFollowingBack: boolean;
  nonBlueVerified: boolean;
  protected: boolean;
  lowTweetCount: boolean;
  followRatio: boolean;
}
```

Extend `FollowingUser`:

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

Extend `Settings`:

```ts
export interface Settings {
  preset: SafetyPreset;
  intervalMinSec: number;
  intervalMaxSec: number;
  hourlyCap: number;
  dailyCap: number;
  sessionCap: number;
  syncTargetCount: number;
  activeHours: ActiveHours;
  scanStrategies: ScanStrategies;
}
```

In `src/shared/defaults.ts`:

```ts
export const STATE_VERSION = 3;

export const DEFAULT_SCAN_STRATEGIES: ScanStrategies = {
  notFollowingBack: true,
  nonBlueVerified: false,
  protected: false,
  lowTweetCount: false,
  followRatio: false,
};
```

Include `scanStrategies: { ...DEFAULT_SCAN_STRATEGIES }` in `createDefaultSettings()`.

In `src/shared/rules.ts` (constants exported for tests/UI):

```ts
export const LOW_TWEET_COUNT_THRESHOLD = 10;
export const FOLLOW_RATIO_MIN_FOLLOWING = 100;
export const FOLLOW_RATIO_MULTIPLIER = 1.2;
```

In `src/shared/safety.ts`:

```ts
import { DEFAULT_SCAN_STRATEGIES } from "./defaults";
import type { ScanStrategies } from "./types";

export function clampScanStrategies(value: Partial<ScanStrategies> | undefined): ScanStrategies {
  const source = value ?? DEFAULT_SCAN_STRATEGIES;
  return {
    notFollowingBack: source.notFollowingBack === true,
    nonBlueVerified: source.nonBlueVerified === true,
    protected: source.protected === true,
    lowTweetCount: source.lowTweetCount === true,
    followRatio: source.followRatio === true,
  };
}
```

At the end of `clampSettings`, add:

```ts
scanStrategies: clampScanStrategies(settings.scanStrategies),
```

- [ ] **Step 4: Run tests and verify PASS**

Run:

```bash
pnpm vitest run tests/shared/safety.test.ts
pnpm typecheck
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/types.ts src/shared/defaults.ts src/shared/safety.ts src/shared/rules.ts tests/shared/safety.test.ts
git commit -m "feat: add scan strategy types and settings defaults"
```

---

### Task 2: Rule engine (`matchReasons` + `selectCandidates`)

**Files:**
- Modify: `src/shared/rules.ts`
- Modify: `tests/shared/rules.test.ts`

**Interfaces:**
- Consumes: `ScanStrategies`, `FollowingUser`, threshold constants from Task 1
- Produces: `matchReasons(user, strategies): ScanStrategyId[]`
- Produces: `selectCandidates(users, whitelist, strategies): FollowingUser[]`
- Produces: `SCAN_STRATEGY_LABELS: Record<ScanStrategyId, string>`
- Produces: `DEFAULT_STRATEGIES` alias or use `DEFAULT_SCAN_STRATEGIES` from defaults

- [ ] **Step 1: Extend test helper and write failing rule tests**

Replace the `user()` helper in `tests/shared/rules.test.ts`:

```ts
import {
  DEFAULT_SCAN_STRATEGIES,
  FOLLOW_RATIO_MIN_FOLLOWING,
  FOLLOW_RATIO_MULTIPLIER,
  LOW_TWEET_COUNT_THRESHOLD,
  matchReasons,
  selectCandidates,
} from "@/shared/rules";
import type { FollowingUser, RelationshipState, ScanStrategies } from "@/shared/types";

function user(
  userId: string,
  handle: string,
  followedBy: RelationshipState,
  overrides: Partial<FollowingUser> = {},
): FollowingUser {
  return {
    userId,
    handle,
    name: `Name ${userId}`,
    avatarUrl: null,
    followedBy,
    isBlueVerified: null,
    protected: null,
    statusesCount: null,
    friendsCount: null,
    followersCount: null,
    syncedAt: 1_700_000_000_000,
    ...overrides,
  };
}

const P0_ONLY: ScanStrategies = { ...DEFAULT_SCAN_STRATEGIES };
const ALL_OFF: ScanStrategies = {
  notFollowingBack: false,
  nonBlueVerified: false,
  protected: false,
  lowTweetCount: false,
  followRatio: false,
};
```

Add tests:

```ts
describe("matchReasons", () => {
  it("matches not-following-back only when followedBy is false", () => {
    const strategies = { ...ALL_OFF, notFollowingBack: true };
    expect(matchReasons(user("1", "a", false), strategies)).toEqual(["not-following-back"]);
    expect(matchReasons(user("2", "b", true), strategies)).toEqual([]);
    expect(matchReasons(user("3", "c", null), strategies)).toEqual([]);
  });

  it("matches non-blue-verified only when isBlueVerified is false", () => {
    const strategies = { ...ALL_OFF, nonBlueVerified: true };
    expect(matchReasons(user("1", "a", true, { isBlueVerified: false }), strategies)).toEqual([
      "non-blue-verified",
    ]);
    expect(matchReasons(user("2", "b", true, { isBlueVerified: true }), strategies)).toEqual([]);
    expect(matchReasons(user("3", "c", true, { isBlueVerified: null }), strategies)).toEqual([]);
  });

  it("matches protected only when protected is true", () => {
    const strategies = { ...ALL_OFF, protected: true };
    expect(matchReasons(user("1", "a", true, { protected: true }), strategies)).toEqual([
      "protected",
    ]);
    expect(matchReasons(user("2", "b", false, { protected: false }), strategies)).toEqual([]);
    expect(matchReasons(user("3", "c", false, { protected: null }), strategies)).toEqual([]);
  });

  it("matches low-tweet-count when statusesCount is below threshold", () => {
    const strategies = { ...ALL_OFF, lowTweetCount: true };
    expect(
      matchReasons(
        user("1", "a", true, { statusesCount: LOW_TWEET_COUNT_THRESHOLD - 1 }),
        strategies,
      ),
    ).toEqual(["low-tweet-count"]);
    expect(
      matchReasons(user("2", "b", true, { statusesCount: LOW_TWEET_COUNT_THRESHOLD }), strategies),
    ).toEqual([]);
    expect(matchReasons(user("3", "c", true, { statusesCount: null }), strategies)).toEqual([]);
  });

  it("matches follow-ratio at the 1.2x boundary with minimum following", () => {
    const strategies = { ...ALL_OFF, followRatio: true };
    const belowMin = user("1", "a", true, {
      friendsCount: FOLLOW_RATIO_MIN_FOLLOWING - 1,
      followersCount: 1,
    });
    const exact = user("2", "b", true, {
      friendsCount: FOLLOW_RATIO_MIN_FOLLOWING,
      followersCount: Math.floor(FOLLOW_RATIO_MIN_FOLLOWING / FOLLOW_RATIO_MULTIPLIER),
    });
    const match = user("3", "c", true, {
      friendsCount: 200,
      followersCount: 100,
    });
    expect(matchReasons(belowMin, strategies)).toEqual([]);
    expect(matchReasons(exact, strategies)).toEqual(["follow-ratio"]);
    expect(matchReasons(match, strategies)).toEqual(["follow-ratio"]);
    expect(
      matchReasons(user("4", "d", true, { friendsCount: 200, followersCount: null }), strategies),
    ).toEqual([]);
  });

  it("returns multiple reasons when several enabled strategies match", () => {
    const strategies = { ...ALL_OFF, notFollowingBack: true, nonBlueVerified: true };
    expect(
      matchReasons(user("1", "a", false, { isBlueVerified: false }), strategies),
    ).toEqual(["not-following-back", "non-blue-verified"]);
  });
});

describe("selectCandidates with strategies", () => {
  it("preserves P0 behavior when only notFollowingBack is enabled", () => {
    const users = [
      user("1", "mutual", true),
      user("2", "candidate", false),
      user("3", "protected", false),
      user("4", "unknown", null),
    ];
    expect(
      selectCandidates(users, [{ userId: "3" }], P0_ONLY).map((item) => item.userId),
    ).toEqual(["2"]);
  });

  it("OR-combines enabled strategies", () => {
    const users = [
      user("1", "mutual-blue", true, { isBlueVerified: true }),
      user("2", "mutual-nonblue", true, { isBlueVerified: false }),
      user("3", "nf-nonblue", false, { isBlueVerified: false }),
    ];
    const strategies = { ...ALL_OFF, nonBlueVerified: true };
    expect(selectCandidates(users, [], strategies).map((item) => item.userId)).toEqual([
      "2",
      "3",
    ]);
  });

  it("returns empty when all strategies are disabled", () => {
    expect(selectCandidates([user("1", "a", false)], [], ALL_OFF)).toEqual([]);
  });

  it("still excludes whitelisted users across strategies", () => {
    const users = [user("1", "a", false, { isBlueVerified: false })];
    const strategies = { ...ALL_OFF, notFollowingBack: true, nonBlueVerified: true };
    expect(selectCandidates(users, [{ handle: "a" }], strategies)).toEqual([]);
  });
});
```

Keep existing whitelist/normalizeHandle tests; update every `selectCandidates(users, whitelist)` call to pass `P0_ONLY` as third argument.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
pnpm vitest run tests/shared/rules.test.ts
```

Expected: FAIL — `matchReasons` not exported; `selectCandidates` arity mismatch.

- [ ] **Step 3: Implement rule engine**

Replace `selectCandidates` body in `src/shared/rules.ts`:

```ts
import { DEFAULT_SCAN_STRATEGIES } from "./defaults";
import type {
  FollowingUser,
  ScanStrategyId,
  ScanStrategies,
  WhitelistEntry,
} from "./types";

export const LOW_TWEET_COUNT_THRESHOLD = 10;
export const FOLLOW_RATIO_MIN_FOLLOWING = 100;
export const FOLLOW_RATIO_MULTIPLIER = 1.2;

export const SCAN_STRATEGY_LABELS: Record<ScanStrategyId, string> = {
  "not-following-back": "未回关",
  "non-blue-verified": "非蓝标",
  protected: "已锁定",
  "low-tweet-count": "推文<10",
  "follow-ratio": "关注/粉丝比",
};

function matchesFollowRatio(user: FollowingUser): boolean {
  const { friendsCount, followersCount } = user;
  if (friendsCount === null || followersCount === null) {
    return false;
  }
  if (friendsCount < FOLLOW_RATIO_MIN_FOLLOWING) {
    return false;
  }
  return friendsCount >= followersCount * FOLLOW_RATIO_MULTIPLIER;
}

export function matchReasons(
  user: FollowingUser,
  strategies: ScanStrategies = DEFAULT_SCAN_STRATEGIES,
): ScanStrategyId[] {
  const reasons: ScanStrategyId[] = [];

  if (strategies.notFollowingBack && user.followedBy === false) {
    reasons.push("not-following-back");
  }
  if (strategies.nonBlueVerified && user.isBlueVerified === false) {
    reasons.push("non-blue-verified");
  }
  if (strategies.protected && user.protected === true) {
    reasons.push("protected");
  }
  if (
    strategies.lowTweetCount &&
    user.statusesCount !== null &&
    user.statusesCount < LOW_TWEET_COUNT_THRESHOLD
  ) {
    reasons.push("low-tweet-count");
  }
  if (strategies.followRatio && matchesFollowRatio(user)) {
    reasons.push("follow-ratio");
  }

  return reasons;
}

export function selectCandidates(
  users: FollowingUser[],
  whitelist: WhitelistEntry[],
  strategies: ScanStrategies = DEFAULT_SCAN_STRATEGIES,
): FollowingUser[] {
  const index = buildWhitelistIndex(whitelist);

  return users.filter(
    (user) => !matchesIndex(user, index) && matchReasons(user, strategies).length > 0,
  );
}
```

- [ ] **Step 4: Run tests and verify PASS**

Run:

```bash
pnpm vitest run tests/shared/rules.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/rules.ts tests/shared/rules.test.ts
git commit -m "feat: add OR-combined scan strategy rule engine"
```

---

### Task 3: Parser — `x-data-adapter.ts`

**Files:**
- Modify: `src/content/x-data-adapter.ts`
- Modify: `tests/content/x-data-adapter.test.ts`
- Modify: `tests/fixtures/following-response.json` (add fields to synthetic users)

**Interfaces:**
- Produces: extended `FollowingUser` objects from `extractFollowingUsers`
- Produces: merge logic that fills gaps without downgrading known values

- [ ] **Step 1: Write failing parser tests**

Add to `tests/content/x-data-adapter.test.ts`:

```ts
it("reads is_blue_verified as a boolean", () => {
  expect(
    extractFrom(modernUser({ is_blue_verified: true }))[0]?.isBlueVerified,
  ).toBe(true);
  expect(
    extractFrom(modernUser({ is_blue_verified: false }))[0]?.isBlueVerified,
  ).toBe(false);
  expect(extractFrom(modernUser({ is_blue_verified: "true" }))[0]?.isBlueVerified).toBeNull();
});

it("reads legacy protected and counts", () => {
  const users = extractFrom(
    modernUser({
      legacy: {
        protected: true,
        statuses_count: 3,
        friends_count: 500,
        followers_count: 100,
      },
    }),
  );
  expect(users[0]).toMatchObject({
    protected: true,
    statusesCount: 3,
    friendsCount: 500,
    followersCount: 100,
  });
});

it("does not downgrade known fields when merging duplicates", () => {
  const first = extractFrom(
    modernUser({
      rest_id: "1",
      relationship_perspectives: { followed_by: false },
      is_blue_verified: false,
    }),
  )[0];
  const second = extractFrom(
    modernUser({
      rest_id: "1",
      relationship_perspectives: { followed_by: false },
      // missing verification in repeat entry
    }),
  )[0];
  const payload = [first, second].filter(Boolean);
  // Simulate collect via two-extract merge path or direct extractFollowingUsers on stitched payload
});
```

Implement the merge test using whatever pattern the file already uses for duplicate users.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
pnpm vitest run tests/content/x-data-adapter.test.ts
```

Expected: FAIL — new properties undefined.

- [ ] **Step 3: Implement parser readers**

Add helpers mirroring `readFollowedBy`:

```ts
function readTriStateBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function readNonNegativeInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return Math.floor(value);
}

function readIsBlueVerified(raw: PlainObject): boolean | null {
  return readTriStateBoolean(raw.is_blue_verified);
}

function readProtected(raw: PlainObject): boolean | null {
  const legacy = readObject(raw, "legacy");
  const fromLegacy = legacy === null ? null : readTriStateBoolean(legacy.protected);
  if (fromLegacy !== null) {
    return fromLegacy;
  }
  return readTriStateBoolean(raw.protected);
}

function readStatusesCount(raw: PlainObject): number | null {
  const legacy = readObject(raw, "legacy");
  return legacy === null ? null : readNonNegativeInt(legacy.statuses_count);
}

function readFriendsCount(raw: PlainObject): number | null {
  const legacy = readObject(raw, "legacy");
  return legacy === null ? null : readNonNegativeInt(legacy.friends_count);
}

function readFollowersCount(raw: PlainObject): number | null {
  const legacy = readObject(raw, "legacy");
  return legacy === null ? null : readNonNegativeInt(legacy.followers_count);
}
```

Extend `normalizeUser` return object with the five new fields.

Update `collect`:

```ts
found.set(user.userId, {
  ...existing,
  name: existing.name === "" ? user.name : existing.name,
  avatarUrl: existing.avatarUrl ?? user.avatarUrl,
  followedBy: existing.followedBy ?? user.followedBy,
  isBlueVerified: existing.isBlueVerified ?? user.isBlueVerified,
  protected: existing.protected ?? user.protected,
  statusesCount: existing.statusesCount ?? user.statusesCount,
  friendsCount: existing.friendsCount ?? user.friendsCount,
  followersCount: existing.followersCount ?? user.followersCount,
});
```

- [ ] **Step 4: Run tests and verify PASS**

Run:

```bash
pnpm vitest run tests/content/x-data-adapter.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/content/x-data-adapter.ts tests/content/x-data-adapter.test.ts tests/fixtures/following-response.json
git commit -m "feat: parse profile fields for scan strategies from Following payloads"
```

---

### Task 4: Trust boundary — `following-batch.ts`

**Files:**
- Modify: `src/shared/following-batch.ts`
- Modify: `tests/shared/following-batch.test.ts`

**Interfaces:**
- Consumes: extended `FollowingUser` shape from Task 1
- Produces: sanitized new fields in `validateFollowingUsers` output

- [ ] **Step 1: Write failing batch tests**

```ts
it("preserves nullable scan fields when they are valid", () => {
  const users = validateFollowingUsers(
    [
      pageUser({
        isBlueVerified: false,
        protected: true,
        statusesCount: 2,
        friendsCount: 150,
        followersCount: 50,
      }),
    ],
    TRUSTED_TIME,
  );

  expect(users[0]).toMatchObject({
    isBlueVerified: false,
    protected: true,
    statusesCount: 2,
    friendsCount: 150,
    followersCount: 50,
  });
});

it("coerces invalid scan fields to null", () => {
  const users = validateFollowingUsers(
    [
      pageUser({
        isBlueVerified: "false",
        protected: 1,
        statusesCount: -3,
        friendsCount: Number.NaN,
        followersCount: "10",
      }),
    ],
    TRUSTED_TIME,
  );

  expect(users[0]).toMatchObject({
    isBlueVerified: null,
    protected: null,
    statusesCount: null,
    friendsCount: null,
    followersCount: null,
  });
});
```

Update comment at top: "Only the eleven known fields survive".

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
pnpm vitest run tests/shared/following-batch.test.ts
```

Expected: FAIL

- [ ] **Step 3: Implement sanitizers in `normalizeRecord`**

```ts
function readTriStateBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function readNonNegativeInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return Math.floor(value);
}

return {
  userId,
  handle,
  name: readName(value.name, budget),
  avatarUrl: readAvatarUrl(value.avatarUrl, budget),
  followedBy: readFollowedBy(value.followedBy),
  isBlueVerified: readTriStateBoolean(value.isBlueVerified),
  protected: readTriStateBoolean(value.protected),
  statusesCount: readNonNegativeInt(value.statusesCount),
  friendsCount: readNonNegativeInt(value.friendsCount),
  followersCount: readNonNegativeInt(value.followersCount),
  syncedAt,
};
```

- [ ] **Step 4: Run tests and verify PASS**

Run:

```bash
pnpm vitest run tests/shared/following-batch.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/following-batch.ts tests/shared/following-batch.test.ts
git commit -m "feat: sanitize scan profile fields at Following batch boundary"
```

---

### Task 5: Store migration and candidate recompute

**Files:**
- Modify: `src/background/store.ts`
- Modify: `tests/background/store.test.ts`
- Modify: `src/background/queue.ts` (three `selectCandidates` call sites)

**Interfaces:**
- Consumes: `selectCandidates(users, whitelist, strategies)`
- Produces: `recomputeCandidates` passes `state.settings.scanStrategies`

- [ ] **Step 1: Write failing store tests**

Extend `user()` helper with null scan fields. Add:

```ts
it("hydrates legacy v2 state with default scan strategies", async () => {
  const legacy = createDefaultState();
  legacy.version = 2;
  delete (legacy.settings as Partial<Settings>).scanStrategies;
  storage.seed(legacy);

  expect((await loadState()).settings.scanStrategies).toEqual(DEFAULT_SCAN_STRATEGIES);
  expect((await loadState()).version).toBe(STATE_VERSION);
});

it("recomputes candidates using enabled scan strategies", () => {
  const synced = {
    ...createDefaultState(),
    following: {
      "1": user("1", "mutual-nonblue", true, {
        isBlueVerified: false,
        syncedAt: 1,
      }),
      "2": user("2", "nf", false, { syncedAt: 2 }),
    },
    settings: {
      ...createDefaultSettings(),
      scanStrategies: {
        ...DEFAULT_SCAN_STRATEGIES,
        notFollowingBack: false,
        nonBlueVerified: true,
      },
    },
  };

  expect(recomputeCandidates(synced).candidates).toEqual(["1"]);
});
```

Update existing `recomputeCandidates` tests to include `scanStrategies` on settings objects.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
pnpm vitest run tests/background/store.test.ts
```

Expected: FAIL

- [ ] **Step 3: Implement store changes**

In `recomputeCandidates`:

```ts
const candidates = selectCandidates(
  Object.values(state.following),
  state.whitelist,
  state.settings.scanStrategies,
).map((user) => user.userId);
```

Extend `migrateSettings`:

```ts
function migrateSettings(settings: Settings, storedVersion: number): Settings {
  let next = settings;

  if (storedVersion < 2) {
    next = clampSettings({
      ...next,
      activeHours: { ...next.activeHours, enabled: false },
    });
  }

  if (storedVersion < 3) {
    next = clampSettings({
      ...next,
      scanStrategies: next.scanStrategies ?? DEFAULT_SCAN_STRATEGIES,
    });
  }

  return next;
}
```

Import `DEFAULT_SCAN_STRATEGIES` from defaults.

Extend `isFollowingUser` to accept missing new fields (legacy records):

```ts
function readOptionalTriState(value: unknown): boolean | null {
  return value === true || value === false ? value : null;
}

function readOptionalCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function isFollowingUser(value: unknown): value is FollowingUser {
  return (
    isRecord(value) &&
    typeof value.userId === "string" &&
    typeof value.handle === "string" &&
    typeof value.name === "string" &&
    (typeof value.avatarUrl === "string" || value.avatarUrl === null) &&
    Number.isFinite(value.syncedAt) &&
    (value.followedBy === true || value.followedBy === false || value.followedBy === null)
  );
}
```

In `hydrateFollowing`, normalize each user:

```ts
following[userId] = {
  userId,
  handle: normalizeHandle(user.handle),
  name: user.name,
  avatarUrl: user.avatarUrl,
  followedBy: user.followedBy,
  isBlueVerified: readOptionalTriState(user.isBlueVerified),
  protected: readOptionalTriState(user.protected),
  statusesCount: readOptionalCount(user.statusesCount),
  friendsCount: readOptionalCount(user.friendsCount),
  followersCount: readOptionalCount(user.followersCount),
  syncedAt: user.syncedAt,
};
```

Update `src/background/queue.ts` — every `selectCandidates(...)` call adds `state.settings.scanStrategies` as third argument (lines ~136, ~626, ~682).

- [ ] **Step 4: Run tests and verify PASS**

Run:

```bash
pnpm vitest run tests/background/store.test.ts tests/background/queue.test.ts
```

Fix any queue tests whose settings factory lacks `scanStrategies`.

- [ ] **Step 5: Commit**

```bash
git add src/background/store.ts src/background/queue.ts tests/background/store.test.ts tests/background/queue.test.ts
git commit -m "feat: wire scan strategies into store recompute and queue"
```

---

### Task 6: Settings UI — scan strategy checkboxes

**Files:**
- Modify: `src/sidepanel/views/SettingsView.tsx`
- Modify: `tests/sidepanel/App.test.tsx` (if present settings coverage)

**Interfaces:**
- Consumes: `Settings.scanStrategies`, `SCAN_STRATEGY_LABELS`, threshold constants
- Produces: persisted strategies via existing `SETTINGS_UPDATE`

- [ ] **Step 1: Write failing UI test**

In `tests/sidepanel/App.test.tsx`, add:

```tsx
it("persists scan strategy toggles from settings", async () => {
  // render App on settings tab, toggle 非蓝标, save, assert send payload includes scanStrategies.nonBlueVerified: true
});
```

Follow existing App test patterns for tab navigation and `send` mock.

- [ ] **Step 2: Run test and verify RED**

Run:

```bash
pnpm vitest run tests/sidepanel/App.test.tsx
```

Expected: FAIL — no scan strategy UI.

- [ ] **Step 3: Implement Settings section**

Add above the whitelist block in `SettingsView.tsx`:

```tsx
import {
  FOLLOW_RATIO_MIN_FOLLOWING,
  FOLLOW_RATIO_MULTIPLIER,
  LOW_TWEET_COUNT_THRESHOLD,
} from "@/shared/rules";
import type { ScanStrategies } from "@/shared/types";

const SCAN_STRATEGY_OPTIONS: Array<{
  key: keyof ScanStrategies;
  label: string;
  hint?: string;
}> = [
  { key: "notFollowingBack", label: "对方未回关" },
  { key: "nonBlueVerified", label: "对方非蓝标" },
  { key: "protected", label: "对方已锁定 / 私密" },
  {
    key: "lowTweetCount",
    label: "推文极少",
    hint: `< ${LOW_TWEET_COUNT_THRESHOLD} 条`,
  },
  {
    key: "followRatio",
    label: "关注远大于粉丝",
    hint: `关注 ≥ ${FOLLOW_RATIO_MIN_FOLLOWING} 且 ≥ 粉丝 × ${FOLLOW_RATIO_MULTIPLIER}`,
  },
];
```

Render checkboxes bound to `draft.scanStrategies[key]`. Footer:

```tsx
<p className="mt-2 text-xs leading-relaxed text-muted">
  满足任一已勾选规则即进入待清理列表；白名单始终排除。
</p>
```

Ensure `useState(state.settings)` resyncs when `state.settings` changes (existing pattern or add `useEffect`).

- [ ] **Step 4: Run test and verify PASS**

Run:

```bash
pnpm vitest run tests/sidepanel/App.test.tsx
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel/views/SettingsView.tsx tests/sidepanel/App.test.tsx
git commit -m "feat: add scan strategy toggles to settings panel"
```

---

### Task 7: Cleanup and Insight UI

**Files:**
- Modify: `src/sidepanel/views/CleanupView.tsx`
- Modify: `src/sidepanel/lib/metrics.ts`
- Modify: `src/sidepanel/views/InsightView.tsx`
- Modify: `tests/sidepanel/metrics.test.ts` (if exists)

**Interfaces:**
- Consumes: `matchReasons`, `SCAN_STRATEGY_LABELS`, `selectCandidates(..., strategies)`
- Produces: dynamic summary line, per-row reason tags, Insight metric `cleanupCandidates`

- [ ] **Step 1: Write failing metrics test**

Add to `tests/sidepanel/metrics.test.ts`:

```ts
import { cleanupCandidateCount } from "@/sidepanel/lib/metrics";
import { DEFAULT_SCAN_STRATEGIES } from "@/shared/defaults";

it("counts cleanup candidates using scan strategies", () => {
  const state = {
    ...createDefaultState(),
    following: {
      "1": { /* mutual non-blue */ },
      "2": { /* mutual blue */ },
    },
    settings: {
      ...createDefaultSettings(),
      scanStrategies: { ...DEFAULT_SCAN_STRATEGIES, notFollowingBack: false, nonBlueVerified: true },
    },
  };
  expect(cleanupCandidateCount(state)).toBe(1);
});
```

- [ ] **Step 2: Run test and verify RED**

Run:

```bash
pnpm vitest run tests/sidepanel/metrics.test.ts
```

Expected: FAIL — `cleanupCandidateCount` missing.

- [ ] **Step 3: Implement UI helpers and views**

In `metrics.ts`:

```ts
import { selectCandidates } from "@/shared/rules";

export function cleanupCandidateCount(state: ExtensionState): number {
  return selectCandidates(
    Object.values(state.following),
    state.whitelist,
    state.settings.scanStrategies,
  ).length;
}

export function enabledStrategyCount(strategies: ExtensionState["settings"]["scanStrategies"]): number {
  return Object.values(strategies).filter(Boolean).length;
}
```

In `CleanupView.tsx`:

```tsx
import { matchReasons, SCAN_STRATEGY_LABELS, selectCandidates } from "@/shared/rules";
import { enabledStrategyCount } from "@/sidepanel/lib/metrics";

const candidates = useMemo(
  () =>
    selectCandidates(
      Object.values(state.following),
      state.whitelist,
      state.settings.scanStrategies,
    ),
  [state.following, state.whitelist, state.settings.scanStrategies],
);

const enabledCount = enabledStrategyCount(state.settings.scanStrategies);
```

Replace summary line:

```tsx
<p className="text-sm text-muted">
  已启用 {enabledCount} 条策略 · 已排除白名单
</p>
```

Pass `reasons={matchReasons(user, state.settings.scanStrategies)}` into `CandidateRow`. Replace hard-coded `未回关` subtitle:

```tsx
<p className="truncate text-xs leading-tight text-muted">
  @{user.handle}
  {reasons.length > 0
    ? ` · ${reasons.map((id) => SCAN_STRATEGY_LABELS[id]).join(" · ")}`
    : ""}
</p>
```

In `InsightView.tsx`, change metric label from `未回关` to `待清理候选` and value to `cleanupCandidateCount(state)`. Keep the existing mutual-rate metrics unchanged.

- [ ] **Step 4: Run tests and verify PASS**

Run:

```bash
pnpm vitest run tests/sidepanel/metrics.test.ts tests/sidepanel/App.test.tsx
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel/views/CleanupView.tsx src/sidepanel/views/InsightView.tsx src/sidepanel/lib/metrics.ts tests/sidepanel/metrics.test.ts
git commit -m "feat: show scan strategy reasons in cleanup and insight views"
```

---

### Task 8: Full verification and test suite cleanup

**Files:**
- Modify: any remaining test factories missing new `FollowingUser` / `Settings` fields

**Interfaces:**
- Consumes: all prior tasks

- [ ] **Step 1: Fix compilation errors across test suite**

Search and update helpers:

```bash
rg "followedBy," tests --glob "*.ts" --glob "*.tsx"
```

Every `FollowingUser` literal needs the five new nullable fields (default `null`). Every `Settings` literal needs `scanStrategies: { ...DEFAULT_SCAN_STRATEGIES }`.

- [ ] **Step 2: Run full test suite**

Run:

```bash
pnpm test
pnpm typecheck
pnpm lint
```

Expected: all PASS

- [ ] **Step 3: Manual smoke checklist**

1. Load extension; open Settings — confirm 5 checkboxes, default only「未回关」checked.
2. Enable「非蓝标」; save; run sync; open Cleanup — mutual non-blue accounts appear with `非蓝标` tag.
3. Disable all strategies — Cleanup shows zero candidates.
4. Whitelist a candidate — they disappear regardless of matched tags.

- [ ] **Step 4: Commit any remaining test fixes**

```bash
git add -A
git commit -m "test: update fixtures for scan strategy fields"
```

---

## Plan self-review

| Spec requirement | Task |
|------------------|------|
| Five toggleable strategies | Task 1–2, 6 |
| OR logic | Task 2 |
| Default P0-only | Task 1 |
| Unknown null-safe | Task 2–4 |
| Fixed thresholds | Task 1–2 |
| No extra network | Task 3 (parser only) |
| Match reason tags | Task 7 |
| STATE_VERSION 3 migration | Task 5 |
| Insight relabel | Task 7 |
| Whitelist veto | Task 2 (tests) |
| Queue wiring | Task 5 |

No TBD placeholders. Type names consistent: `ScanStrategies`, `matchReasons`, `SCAN_STRATEGY_LABELS`.
