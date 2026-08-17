# Configurable Sync Scroll Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each Following sync discover 1000 accounts by default, support a persisted 100–5000 target, and wait a fresh random 1–15 seconds between scrolls.

**Architecture:** Extend the existing persisted `Settings` model with `syncTargetCount`, clamp it at every storage boundary, and carry the clamped value in `SCROLL_SESSION_START`. The cached content controller snapshots that value at `start(syncTargetCount)`, stops by new discoveries in the current round, and retains existing hidden/auth/stall protections.

**Tech Stack:** TypeScript 6, React 19, Tailwind CSS 4, Chrome MV3 messaging/storage, Vitest, Testing Library.

## Global Constraints

- `syncTargetCount`: default `1000`, minimum `100`, maximum `5000`.
- Every normal scroll delay is independently sampled from inclusive `[1000, 15000]` milliseconds.
- The target counts newly discovered accounts since the current round started.
- Remove 8-minute and 120-step user-facing stop conditions; keep no-growth, hidden-tab, auth, user-pause, and queue mutual exclusion behavior.
- Do not change unfollow intervals, quotas, Following batch limits, step distance, or reverse-scroll behavior.
- Add no dependencies and do not modify the existing untracked `pnpm-lock.yaml`.
- Do not create commits unless the user explicitly asks.

---

### Task 1: Persist and clamp the sync target

**Files:**
- Modify: `src/shared/types.ts:54-62`
- Modify: `src/shared/safety.ts:24-30, 54-60, 114-142`
- Modify: `tests/shared/safety.test.ts`
- Modify: `tests/background/store.test.ts`

**Interfaces:**
- Produces: `Settings.syncTargetCount: number`
- Produces: `HARD_LIMITS.minSyncTargetCount` and `HARD_LIMITS.maxSyncTargetCount`
- Produces: `SAFE_SETTINGS.syncTargetCount === 1000`
- Preserves: `clampSettings(settings: Settings): Settings`

- [ ] **Step 1: Write failing settings tests**

Add `syncTargetCount: 1000` to the test `settings()` factory, then add:

```ts
it("defaults the sync target to 1000", () => {
  expect(createDefaultSettings().syncTargetCount).toBe(1_000);
});

it.each([
  [1, 100],
  [100, 100],
  [1_234.9, 1_234],
  [5_000, 5_000],
  [99_999, 5_000],
  [Number.NaN, 1_000],
])("clamps sync target %s to %s", (value, expected) => {
  expect(clampSettings(settings({ syncTargetCount: value })).syncTargetCount).toBe(expected);
});

it("keeps the sync target independent of safety presets", () => {
  expect(clampSettings(settings({ preset: "safe", syncTargetCount: 2_000 })).syncTargetCount).toBe(
    2_000,
  );
  expect(
    clampSettings(settings({ preset: "balanced", syncTargetCount: 3_000 })).syncTargetCount,
  ).toBe(3_000);
});
```

In the store hydration suite, seed a legacy settings object without the new property and assert:

```ts
expect((await loadState()).settings.syncTargetCount).toBe(1_000);
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
pnpm vitest run tests/shared/safety.test.ts tests/background/store.test.ts
```

Expected: TypeScript/test failures because `syncTargetCount` and the hard limits do not exist, and legacy hydration does not restore the new default.

- [ ] **Step 3: Implement the settings field and clamp**

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
}
```

Extend constants:

```ts
export const HARD_LIMITS = {
  minIntervalSec: 60,
  maxHourlyCap: 12,
  maxDailyCap: 40,
  maxSessionCap: 20,
  minSyncTargetCount: 100,
  maxSyncTargetCount: 5_000,
} as const;

export const DEFAULT_SYNC_TARGET_COUNT = 1_000;
```

Include `syncTargetCount: DEFAULT_SYNC_TARGET_COUNT` in `SAFE_SETTINGS`. In `clampSettings`, compute this before the preset branch:

```ts
const syncTargetCount = Number.isFinite(settings.syncTargetCount)
  ? clampInt(
      settings.syncTargetCount,
      HARD_LIMITS.minSyncTargetCount,
      HARD_LIMITS.maxSyncTargetCount,
    )
  : DEFAULT_SYNC_TARGET_COUNT;
```

Return `syncTargetCount` from both preset and custom branches:

```ts
if (preset !== "custom") {
  return { preset, ...PRESET_LIMITS[preset], syncTargetCount, activeHours };
}
```

```ts
return {
  preset,
  intervalMinSec,
  intervalMaxSec,
  hourlyCap: clampInt(settings.hourlyCap, 1, HARD_LIMITS.maxHourlyCap),
  dailyCap: clampInt(settings.dailyCap, 1, HARD_LIMITS.maxDailyCap),
  sessionCap: clampInt(settings.sessionCap, 1, HARD_LIMITS.maxSessionCap),
  syncTargetCount,
  activeHours,
};
```

Because `hydrateSection` spreads legacy state over defaults before calling `clampSettings`, the missing field resolves to `1000`; verify this rather than adding a state-version migration.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
pnpm vitest run tests/shared/safety.test.ts tests/background/store.test.ts
```

Expected: both files pass with no warnings.

---

### Task 2: Carry the target through worker-to-content messaging

**Files:**
- Modify: `src/shared/messages.ts:30-41`
- Modify: `src/background/sync-coordinator.ts:220-250, 449-495`
- Modify: `src/content/isolated.ts:219-278`
- Modify: `tests/shared/messages.test.ts`
- Modify: `tests/background/sync-coordinator.test.ts`
- Modify: `tests/content/isolated.test.ts`

**Interfaces:**
- Consumes: `Settings.syncTargetCount`
- Produces: `{ type: "SCROLL_SESSION_START"; syncTargetCount: number }`
- Produces: `ScrollController.start(syncTargetCount?: number): void` (implemented in Task 3; tests may temporarily fail typecheck until Task 3 is complete)

- [ ] **Step 1: Write failing protocol and coordinator tests**

Update valid-message fixtures:

```ts
{ type: "SCROLL_SESSION_START", syncTargetCount: 1_000 }
```

In `startSync` tests, seed `settings.syncTargetCount: 2_000` and assert:

```ts
expect(tabs.messages).toContainEqual({
  tabId: 7,
  message: { type: "SCROLL_SESSION_START", syncTargetCount: 2_000 },
});
```

In the matching-account re-delivery test for `applyAuthStatus`, seed `syncTargetCount: 3_000` and assert the same message shape with `3_000`.

In the isolated runtime test, deliver:

```ts
listener({ type: "SCROLL_SESSION_START", syncTargetCount: 1_500 });
```

Then assert the controller start path receives `1_500` through its observable status/behavior once Task 3 is integrated.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
pnpm vitest run tests/shared/messages.test.ts tests/background/sync-coordinator.test.ts tests/content/isolated.test.ts
```

Expected: failures show the start message lacks `syncTargetCount`, and content does not forward it to the controller.

- [ ] **Step 3: Implement the message payload and worker delivery**

Change the union member:

```ts
| { type: "SCROLL_SESSION_START"; syncTargetCount: number }
```

In `startSync`, use the already loaded and hydrated state:

```ts
const delivered = await sendToTab(tabId, {
  type: "SCROLL_SESSION_START",
  syncTargetCount: state.settings.syncTargetCount,
});
```

In `applyAuthStatus`, use the hydrated `before` snapshot for re-delivery:

```ts
if (before.syncMeta.status === "running" && sameAccount(owner, normalized)) {
  await sendToTab(tabId, {
    type: "SCROLL_SESSION_START",
    syncTargetCount: before.settings.syncTargetCount,
  });
}
```

In `isolated.ts`:

```ts
case "SCROLL_SESSION_START":
  authProbe.probe();
  ensureController().start(message.syncTargetCount);
  break;
```

The controller independently clamps this runtime input in Task 3 so an untyped/tampered sender cannot exceed 5000.

- [ ] **Step 4: Run focused tests after Task 3 interface is available**

Run:

```bash
pnpm vitest run tests/shared/messages.test.ts tests/background/sync-coordinator.test.ts tests/content/isolated.test.ts
```

Expected: all three test files pass.

---

### Task 3: Stop by newly discovered accounts and randomize every delay

**Files:**
- Modify: `src/content/scroll-controller.ts`
- Modify: `tests/content/scroll-controller.test.ts`
- Modify: `src/sidepanel/views/InsightView.tsx:27-29`

**Interfaces:**
- Consumes: `ScrollController.start(syncTargetCount?: number)`
- Consumes: clamp range `100–5000`, default `1000`
- Preserves: all other `ScrollController` methods and `ScrollStatus`

- [ ] **Step 1: Replace budget/timing tests with failing desired-behavior tests**

Update delay test:

```ts
it("waits a freshly randomized 1-15 seconds before every scroll", () => {
  const fake = createFakeEnvironment();
  const controller = createScrollController({ env: fake.env });

  fake.queueRandoms(0);
  controller.start();
  expect(fake.lastDelay()).toBe(1_000);

  queueStep(fake, FORWARD, 0.5, 1);
  fake.discover(1);
  fake.tick();
  expect(fake.lastDelay()).toBe(15_000);
});
```

Adjust `queueStep` so a step consumes three draws—direction, distance, next delay—rather than short/long pause branches:

```ts
function queueStep(fake: Fake, kind: number, distance = 0.5, delay = 0.5) {
  fake.queueRandoms(kind, distance, delay);
}
```

Add target tests using a low injected target through `start(100)` and batches that reach exactly the target:

```ts
it("pauses after discovering the configured number of new accounts", () => {
  const fake = createFakeEnvironment();
  const controller = createScrollController({ env: fake.env });
  fake.discover(40);
  controller.start(100);

  for (let step = 0; step < 10 && controller.getStatus().status === "running"; step += 1) {
    queueStep(fake, FORWARD);
    fake.discover(10);
    fake.tick();
  }

  expect(controller.getStatus()).toMatchObject({
    status: "paused",
    pauseReason: "budget",
    discoveredCount: 140,
  });
  expect(fake.pending).toBeNull();
});
```

Add:

```ts
it("clamps a runtime target below 100", () => {
  const fake = createFakeEnvironment();
  const controller = createScrollController({ env: fake.env });
  controller.start(1);

  for (let count = 0; count < 99; count += 1) {
    queueStep(fake, FORWARD);
    fake.discover(1);
    fake.tick();
  }
  expect(controller.getStatus().status).toBe("running");

  queueStep(fake, FORWARD);
  fake.discover(1);
  fake.tick();
  expect(controller.getStatus()).toMatchObject({ status: "paused", pauseReason: "budget" });
});

it("does not stop merely because 120 steps or 8 active minutes elapsed", () => {
  const fake = createFakeEnvironment();
  const controller = createScrollController({ env: fake.env });
  controller.start(5_000);

  for (let count = 0; count < 121; count += 1) {
    queueStep(fake, FORWARD, 0.5, 1);
    fake.discover(1);
    fake.tick();
  }

  expect(controller.getStatus()).toMatchObject({ status: "running", stepCount: 121 });
});

it("uses a fresh discovery baseline for the next round", () => {
  const fake = createFakeEnvironment();
  const controller = createScrollController({ env: fake.env });

  for (let round = 0; round < 2; round += 1) {
    controller.start(100);
    for (let count = 0; count < 100; count += 1) {
      queueStep(fake, FORWARD);
      fake.discover(1);
      fake.tick();
    }
    expect(controller.getStatus()).toMatchObject({ status: "paused", pauseReason: "budget" });
  }

  expect(controller.getStatus().discoveredCount).toBe(200);
});
```

Retain all existing no-growth, hidden, pause/resume, stop, reverse-scroll, and status-report tests.

- [ ] **Step 2: Run controller tests and verify RED**

Run:

```bash
pnpm vitest run tests/content/scroll-controller.test.ts
```

Expected: failures because delays still use two bands, `start` does not accept a target, and 8-minute/120-step stops still fire.

- [ ] **Step 3: Implement round target state and simplified delay**

Change timing fields in `ScrollLimits` and defaults:

```ts
minPauseMs: 1_000,
maxPauseMs: 15_000,
```

Remove `longPauseProbability`, `minLongPauseMs`, `maxLongPauseMs`, `maxRoundMs`, and `maxSteps`. Import the single shared source of truth:

```ts
import { DEFAULT_SYNC_TARGET_COUNT, HARD_LIMITS } from "@/shared/safety";
```

Extend `RoundState`:

```ts
startDiscoveredCount: number;
syncTargetCount: number;
```

Initialize defaults in `createRound`, then normalize runtime input:

```ts
function normalizeSyncTargetCount(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_SYNC_TARGET_COUNT;
  }

  return Math.min(
    HARD_LIMITS.maxSyncTargetCount,
    Math.max(HARD_LIMITS.minSyncTargetCount, Math.floor(value as number)),
  );
}
```

Change the public method:

```ts
start(syncTargetCount?: number): void;
```

At round start:

```ts
round = {
  ...createRound(),
  startedAt: now,
  resumedAt: now,
  lastGrowthAt: now,
  discoveredCount: discovered,
  startDiscoveredCount: discovered,
  growthBaseline: discovered,
  syncTargetCount: normalizeSyncTargetCount(syncTargetCount),
};
```

Simplify scheduling:

```ts
function scheduleStep(): void {
  schedule(between(limits.minPauseMs, limits.maxPauseMs));
}
```

After refreshing `round.discoveredCount` and judging prior growth, stop before another scroll when:

```ts
if (round.discoveredCount - round.startDiscoveredCount >= round.syncTargetCount) {
  pause("budget");
  return;
}
```

Do not run this before `judgeGrowth()`: the latest accepted growth must reset the no-growth counter first. Remove the elapsed-active and step-count budget check. Keep `stepCount` as progress telemetry.

When a user starts after budget, `start(newTarget)` creates a fresh round and baseline. `resume()` remains for same-round internal behavior and must not silently change the target.

Update Insight copy:

```tsx
<StatusBanner>本轮同步已达到人数上限，可继续发起下一轮。</StatusBanner>
```

- [ ] **Step 4: Run controller and integration tests and verify GREEN**

Run:

```bash
pnpm vitest run tests/content/scroll-controller.test.ts tests/content/isolated.test.ts tests/background/sync-coordinator.test.ts
```

Expected: all pass; timing tests contain no references to old 1.5–4s / 6–12s bands or 8-minute / 120-step budgets.

---

### Task 4: Add the Settings UI control

**Files:**
- Modify: `src/sidepanel/views/SettingsView.tsx`
- Modify: `tests/sidepanel/App.test.tsx`

**Interfaces:**
- Consumes: `state.settings.syncTargetCount`
- Produces: existing `SETTINGS_UPDATE` message with the complete clamped `Settings`

- [ ] **Step 1: Write failing UI tests**

Navigate to Settings using the existing tab control, then:

```ts
expect(screen.getByRole("spinbutton", { name: "每轮同步人数" })).toHaveValue(1_000);
expect(screen.getByText("100–5000，默认 1000")).toBeInTheDocument();
```

Change and save:

```ts
fireEvent.change(screen.getByRole("spinbutton", { name: "每轮同步人数" }), {
  target: { value: "2500" },
});
fireEvent.click(screen.getByRole("button", { name: "保存设置" }));

expect(messages).toContainEqual({
  type: "SETTINGS_UPDATE",
  settings: expect.objectContaining({ syncTargetCount: 2_500 }),
});
```

Add an out-of-range case (`99999`) and assert the sent value is `5000`.

- [ ] **Step 2: Run the side-panel test and verify RED**

Run:

```bash
pnpm vitest run tests/sidepanel/App.test.tsx
```

Expected: the named spinbutton and helper copy are missing.

- [ ] **Step 3: Implement the Tailwind numeric field**

Add this block above the save button:

```tsx
<label className="block space-y-2 text-sm">
  <span className="font-medium">每轮同步人数</span>
  <input
    type="number"
    min={HARD_LIMITS.minSyncTargetCount}
    max={HARD_LIMITS.maxSyncTargetCount}
    step={100}
    value={draft.syncTargetCount}
    onChange={(event) =>
      setDraft((current) => ({
        ...current,
        syncTargetCount: Number(event.target.value),
      }))
    }
    className="min-h-11 w-full rounded-[var(--radius-panel)] border border-border bg-surface px-3 text-sm"
  />
  <span className="block text-xs text-muted">100–5000，默认 1000</span>
</label>
```

Keep the existing save flow:

```ts
send({ type: "SETTINGS_UPDATE", settings: clampSettings(draft) })
```

Do not add a second save button or a separate storage key.

- [ ] **Step 4: Run the UI test and verify GREEN**

Run:

```bash
pnpm vitest run tests/sidepanel/App.test.tsx
```

Expected: all side-panel tests pass.

---

### Task 5: Full verification and documentation alignment

**Files:**
- Modify: `docs/manual-test-checklist.md`
- Verify: all changed source and test files

**Interfaces:**
- No new interfaces.

- [ ] **Step 1: Update manual checks**

Add checks for:

```markdown
- [ ] “每轮同步人数” defaults to 1000 and persists values from 100 to 5000.
- [ ] A large Following sync pauses after approximately the configured number of newly discovered accounts.
- [ ] Successive scroll waits vary within 1–15 seconds.
- [ ] The round no longer pauses solely at 8 minutes or 120 steps.
```

Keep the existing hidden-tab, stall, auth, and queue mutual-exclusion checks.

- [ ] **Step 2: Run formatting**

Run:

```bash
pnpm prettier --write src tests docs/manual-test-checklist.md
```

Expected: command exits 0 and only formats files in scope.

- [ ] **Step 3: Run the complete verification suite**

Run:

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

Expected: all commands exit 0 with no TypeScript, ESLint, Vitest, or Vite errors.

- [ ] **Step 4: Inspect final diff and workspace state**

Run:

```bash
git status --short
git diff --check
git diff -- src tests docs
```

Expected:

- `git diff --check` exits 0.
- The pre-existing untracked `pnpm-lock.yaml` remains untouched.
- Every changed source line traces to configurable sync target, 1–15s delay, UI, tests, or documentation.
- No commit is created.
