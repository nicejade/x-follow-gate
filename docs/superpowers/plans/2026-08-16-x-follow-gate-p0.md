# X Follow Gate P0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local-only Chrome MV3 extension that progressively scrolls the signed-in X.com Following page, identifies accounts that do not follow back, applies a whitelist, and performs explicitly confirmed unfollows through a conservative, pausable queue.

**Architecture:** A React + Tailwind Side Panel sends typed commands to an ephemeral MV3 service worker. The worker owns persisted state, safety limits, alarms, and queue coordination; isolated and main-world content scripts observe X page-loaded relationship data, control progressive scrolling, detect authentication, and perform one UI-driven unfollow at a time. No server, exported cookie, direct background pagination, or concurrent write operation is allowed.

**Tech Stack:** Chrome Extension Manifest V3, TypeScript, React, Vite, Tailwind CSS, Vitest, Testing Library, ESLint, Prettier.

## Global Constraints

- Target personal / small trusted-circle unpacked distribution; Chrome Web Store packaging is out of scope.
- Host access is limited to `https://x.com/*` and `https://twitter.com/*`.
- All state remains in `chrome.storage.local`; no analytics, cloud sync, cookie export, or remote configuration.
- Following data is obtained only while progressively scrolling the visible Following page; no extension-owned GraphQL pagination.
- Sync and unfollow are mutually exclusive.
- Unfollow is single-flight and must be started from preview confirmation.
- Safe defaults: interval 90–150 seconds, ≤5/hour, ≤20/day, ≤10/session.
- Balanced defaults: interval 75–120 seconds, ≤8/hour, ≤30/day, ≤15/session.
- Hard limits: interval ≥60 seconds, ≤12/hour, ≤40/day, ≤20/session.
- A 401/403/429-equivalent UI failure or three consecutive failures pauses the queue for 60 minutes.
- Following tab hidden for ≥45 seconds pauses scrolling.
- One sync round stops after 8 minutes, 120 scroll steps, or 5 consecutive no-growth steps.
- UI text is Chinese; code comments and documentation are professional English.
- Do not create git commits unless the user explicitly requests them.

---

## File Map

```text
.
├── package.json
├── tsconfig.json
├── vite.config.ts
├── vitest.config.ts
├── eslint.config.js
├── src
│   ├── manifest.ts
│   ├── shared
│   │   ├── types.ts              # Domain models and state machine types
│   │   ├── messages.ts           # Typed runtime message protocol
│   │   ├── safety.ts             # Presets, hard clamps, quota decisions
│   │   ├── rules.ts              # Pure P0 candidate/whitelist logic
│   │   └── defaults.ts           # Initial persisted state
│   ├── background
│   │   ├── index.ts              # Top-level MV3 listeners
│   │   ├── store.ts              # Atomic chrome.storage.local access
│   │   ├── sync-coordinator.ts   # Sync lifecycle and mutual exclusion
│   │   ├── queue.ts              # Unfollow state machine
│   │   └── tab-router.ts         # Following/profile tab coordination
│   ├── content
│   │   ├── isolated.ts           # Chrome messaging and page bridge
│   │   ├── main-world.ts         # Passive fetch/XHR response observer
│   │   ├── x-data-adapter.ts     # Version-tolerant relationship parser
│   │   ├── scroll-controller.ts  # Progressive scrolling state machine
│   │   ├── auth-detector.ts      # Signed-in account detection
│   │   └── unfollow-driver.ts    # One UI-driven unfollow attempt
│   └── sidepanel
│       ├── index.html
│       ├── main.tsx
│       ├── App.tsx
│       ├── styles.css
│       ├── hooks/useExtensionState.ts
│       ├── components/AppShell.tsx
│       ├── components/StatusBanner.tsx
│       ├── views/InsightView.tsx
│       ├── views/CleanupView.tsx
│       ├── views/SettingsView.tsx
│       └── components/ConfirmQueueDialog.tsx
└── tests
    ├── setup.ts
    ├── fixtures/following-response.json
    ├── shared/safety.test.ts
    ├── shared/rules.test.ts
    ├── content/x-data-adapter.test.ts
    ├── content/scroll-controller.test.ts
    ├── content/unfollow-driver.test.ts
    ├── background/queue.test.ts
    └── sidepanel/App.test.tsx
```

---

### Task 1: Scaffold the MV3 Extension and Quality Tooling

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vite.config.ts`
- Create: `vitest.config.ts`
- Create: `eslint.config.js`
- Create: `src/manifest.ts`
- Create: `src/sidepanel/index.html`
- Create: `tests/setup.ts`

**Interfaces:**
- Produces build entries named `background`, `content-isolated`, `content-main-world`, and `sidepanel`.
- Produces `dist/manifest.json` suitable for loading unpacked.

- [ ] **Step 1: Initialize package metadata and install current dependencies**

Run:

```bash
npm init -y
npm install react react-dom
npm install -D typescript vite vitest jsdom @vitejs/plugin-react tailwindcss @tailwindcss/vite @types/chrome @types/react @types/react-dom @testing-library/react @testing-library/jest-dom eslint @eslint/js typescript-eslint prettier
```

Expected: dependencies install without audit-blocking errors and no application code is generated.

- [ ] **Step 2: Add exact scripts to `package.json`**

```json
{
  "scripts": {
    "dev": "vite build --watch --mode development",
    "build": "vite build",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "lint": "eslint .",
    "format:check": "prettier --check ."
  }
}
```

- [ ] **Step 3: Configure TypeScript, Vite, Vitest, Tailwind, and ESLint**

Use strict TypeScript with `noUncheckedIndexedAccess`, DOM + Chrome types, React JSX, and `@/*` mapped to `src/*`. Configure Vite multi-entry output and copy the generated manifest to `dist`. Configure Vitest for `jsdom`, `tests/setup.ts`, and alias parity with Vite.

- [ ] **Step 4: Create the MV3 manifest**

```ts
export const manifest: chrome.runtime.ManifestV3 = {
  manifest_version: 3,
  name: "Follow Gate",
  version: "0.1.0",
  description: "本地分析 X 关注关系，并以保守队列清理未回关账号。",
  minimum_chrome_version: "114",
  permissions: ["storage", "alarms", "sidePanel", "tabs", "scripting"],
  host_permissions: ["https://x.com/*", "https://twitter.com/*"],
  background: {
    service_worker: "background.js",
    type: "module"
  },
  side_panel: {
    default_path: "sidepanel/index.html"
  },
  action: {
    default_title: "打开 Follow Gate"
  },
  content_scripts: [
    {
      matches: ["https://x.com/*", "https://twitter.com/*"],
      js: ["content-main-world.js"],
      run_at: "document_start",
      world: "MAIN"
    },
    {
      matches: ["https://x.com/*", "https://twitter.com/*"],
      js: ["content-isolated.js"],
      run_at: "document_start",
      world: "ISOLATED"
    }
  ]
};
```

- [ ] **Step 5: Add a smoke test for manifest safety**

```ts
it("limits host access and declares MV3", () => {
  expect(manifest.manifest_version).toBe(3);
  expect(manifest.host_permissions).toEqual([
    "https://x.com/*",
    "https://twitter.com/*"
  ]);
  expect(manifest.permissions).not.toContain("cookies");
});
```

- [ ] **Step 6: Verify the scaffold**

Run:

```bash
npm run test
npm run typecheck
npm run build
```

Expected: all commands exit 0 and `dist/manifest.json` exists.

---

### Task 2: Define Domain Types, Defaults, Safety Limits, and P0 Rules

**Files:**
- Create: `src/shared/types.ts`
- Create: `src/shared/defaults.ts`
- Create: `src/shared/safety.ts`
- Create: `src/shared/rules.ts`
- Test: `tests/shared/safety.test.ts`
- Test: `tests/shared/rules.test.ts`

**Interfaces:**
- Produces `ExtensionState`, `FollowingUser`, `Settings`, `SyncMeta`, `UnfollowQueue`, and `AuditEntry`.
- Produces `clampSettings(settings): Settings`, `canRunNext(queue, now): QuotaDecision`, and `selectCandidates(users, whitelist): FollowingUser[]`.

- [ ] **Step 1: Write failing rule tests**

```ts
it("selects only explicit non-followers not on the whitelist", () => {
  const users = [
    user("1", "mutual", true),
    user("2", "candidate", false),
    user("3", "protected", false),
    user("4", "unknown", null)
  ];

  expect(selectCandidates(users, [{ userId: "3" }]).map((item) => item.userId))
    .toEqual(["2"]);
});
```

The unknown relationship (`null`) must never be treated as non-mutual.

- [ ] **Step 2: Write failing safety tests**

```ts
it("clamps custom settings to hard safety limits", () => {
  const result = clampSettings({
    preset: "custom",
    intervalMinSec: 1,
    intervalMaxSec: 20,
    hourlyCap: 99,
    dailyCap: 99,
    sessionCap: 99,
    activeHours: { enabled: false, start: "09:00", end: "23:00" }
  });

  expect(result).toMatchObject({
    intervalMinSec: 60,
    intervalMaxSec: 60,
    hourlyCap: 12,
    dailyCap: 40,
    sessionCap: 20
  });
});
```

Add cases for Safe and Balanced exact values, cooldown, active hours, hourly/day/session caps, and `nextAt`.

- [ ] **Step 3: Run tests and confirm failure**

Run:

```bash
npm test -- tests/shared/rules.test.ts tests/shared/safety.test.ts
```

Expected: FAIL because the shared modules do not exist.

- [ ] **Step 4: Implement exact domain models and pure functions**

Use:

```ts
export type RelationshipState = true | false | null;

export interface FollowingUser {
  userId: string;
  handle: string;
  name: string;
  avatarUrl: string | null;
  followedBy: RelationshipState;
  syncedAt: number;
}

export type QueueStatus =
  | "idle"
  | "running"
  | "paused"
  | "cooldown"
  | "completed"
  | "stopped";
```

Store counts as timestamp arrays for hour/day enforcement rather than mutable counters that can drift. Normalize handles to lowercase without `@`.

- [ ] **Step 5: Run focused tests**

Run:

```bash
npm test -- tests/shared/rules.test.ts tests/shared/safety.test.ts
```

Expected: PASS.

---

### Task 3: Create the Typed Message Protocol and Atomic Local Store

**Files:**
- Create: `src/shared/messages.ts`
- Create: `src/background/store.ts`
- Test: `tests/background/store.test.ts`

**Interfaces:**
- Produces discriminated union `ExtensionMessage`.
- Produces `loadState(): Promise<ExtensionState>`, `replaceState(next): Promise<void>`, and `updateState(mutator): Promise<ExtensionState>`.

- [ ] **Step 1: Define protocol compile-time contracts**

```ts
export type ExtensionMessage =
  | { type: "STATE_GET" }
  | { type: "SYNC_START" }
  | { type: "SYNC_PAUSE"; reason: "user" | "hidden" | "budget" | "stalled" }
  | { type: "SYNC_STOP" }
  | { type: "FOLLOWING_BATCH"; users: FollowingUser[] }
  | { type: "SCROLL_STATUS"; status: ScrollStatus }
  | { type: "QUEUE_START"; userIds: string[] }
  | { type: "QUEUE_PAUSE"; reason: QueuePauseReason }
  | { type: "QUEUE_STOP" }
  | { type: "UNFOLLOW_READY"; tabId: number; account: AccountIdentity | null }
  | { type: "UNFOLLOW_RESULT"; result: UnfollowResult }
  | { type: "SETTINGS_UPDATE"; settings: Settings }
  | { type: "WHITELIST_UPDATE"; entries: WhitelistEntry[] };
```

Add `assertNever(value: never)` for exhaustive handling.

- [ ] **Step 2: Write failing storage tests with a mocked `chrome.storage.local`**

Verify default-state hydration, serialized updates, candidate recomputation after `FOLLOWING_BATCH`, and no loss when two updates are requested in sequence.

- [ ] **Step 3: Implement a single-process update chain**

```ts
let updateChain = Promise.resolve();

export function updateState(
  mutator: (current: ExtensionState) => ExtensionState
): Promise<ExtensionState> {
  const operation = updateChain.then(async () => {
    const current = await loadState();
    const next = mutator(current);
    await chrome.storage.local.set({ extensionState: next });
    return next;
  });
  updateChain = operation.then(() => undefined, () => undefined);
  return operation;
}
```

The service worker may restart, so every operation still reloads persisted state; the chain only prevents overlap during one lifetime.

- [ ] **Step 4: Run tests and typecheck**

Run:

```bash
npm test -- tests/background/store.test.ts
npm run typecheck
```

Expected: PASS.

---

### Task 4: Parse Only Page-Loaded Following Data

**Files:**
- Create: `src/content/x-data-adapter.ts`
- Create: `src/content/main-world.ts`
- Create: `tests/fixtures/following-response.json`
- Test: `tests/content/x-data-adapter.test.ts`

**Interfaces:**
- Produces `extractFollowingUsers(payload, now): FollowingUser[]`.
- Main world posts `{ source: "follow-gate", type: "FOLLOWING_PAGE_DATA", users }`.
- Must not initiate any X network request.

- [ ] **Step 1: Capture a redacted real Following response fixture manually**

Use Chrome DevTools while manually opening and scrolling `/following`. Remove names, handles, IDs, URLs, and unrelated timeline content, while preserving the nesting and relationship fields required by the parser. Store only the minimal sanitized structure in `tests/fixtures/following-response.json`.

- [ ] **Step 2: Write parser tests**

Cover:
- `relationship_perspectives.followed_by`
- legacy `legacy.followed_by` fallback
- tombstones, cursors, promoted entries, and malformed users ignored
- duplicate user IDs deduplicated
- missing relationship represented as `null`, never `false`

- [ ] **Step 3: Implement a version-tolerant iterative traversal**

```ts
export function extractFollowingUsers(
  payload: unknown,
  now = Date.now()
): FollowingUser[] {
  const found = new Map<string, FollowingUser>();
  const stack: unknown[] = [payload];

  while (stack.length > 0) {
    const value = stack.pop();
    // Guard plain objects/arrays, recognize user result shapes,
    // normalize fields, and continue traversal without recursion.
  }

  return [...found.values()];
}
```

Do not infer `followedBy: false` from absent fields.

- [ ] **Step 4: Passively observe fetch and XHR responses in main world**

Wrap `window.fetch` and `XMLHttpRequest` without changing arguments, headers, timing, return values, or error behavior. Clone successful JSON responses only when URL/path indicates a Following timeline. Parse locally and post only normalized users, never raw payload, cookie, CSRF token, or authorization header.

- [ ] **Step 5: Verify parser and build**

Run:

```bash
npm test -- tests/content/x-data-adapter.test.ts
npm run build
```

Expected: PASS; built main-world script contains no Chrome API calls.

---

### Task 5: Implement Progressive Scroll Sync and Authentication Detection

**Files:**
- Create: `src/content/scroll-controller.ts`
- Create: `src/content/auth-detector.ts`
- Create: `src/content/isolated.ts`
- Create: `src/background/sync-coordinator.ts`
- Test: `tests/content/scroll-controller.test.ts`
- Test: `tests/background/sync-coordinator.test.ts`

**Interfaces:**
- Produces `ScrollController` with `start()`, `pause(reason)`, `resume()`, and `stop()`.
- Produces `detectAccount(document): AccountIdentity | null`.
- Consumes normalized `FOLLOWING_PAGE_DATA` window messages and emits `FOLLOWING_BATCH`.

- [ ] **Step 1: Write deterministic scroll-controller tests**

Inject dependencies:

```ts
interface ScrollEnvironment {
  now(): number;
  random(): number;
  isVisible(): boolean;
  scrollBy(deltaY: number): void;
  schedule(callback: () => void, delayMs: number): number;
  cancel(timerId: number): void;
}
```

Verify:
- each forward step is 40%–80% of viewport
- pauses are 1.5–4s with occasional 6–12s long pause
- occasional small reverse movement
- hidden ≥45s pauses
- 8 minutes / 120 steps / 5 no-growth steps stop the round
- stop cancels pending work

- [ ] **Step 2: Implement the controller without periodic fixed timers**

Each completed step schedules exactly one next step with a freshly randomized delay. Track `startedAt`, `stepCount`, `lastGrowthAt`, `noGrowthSteps`, and `hiddenSince`.

- [ ] **Step 3: Implement auth detection**

Read stable page links/accessible labels and the current account switcher DOM; return a normalized user ID/handle only when confidence is sufficient. Unknown is `null` and blocks write operations.

- [ ] **Step 4: Bridge main-world data safely**

In isolated world:

```ts
window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  if (event.origin !== window.location.origin) return;
  if (event.data?.source !== "follow-gate") return;
  if (event.data?.type !== "FOLLOWING_PAGE_DATA") return;
  chrome.runtime.sendMessage({
    type: "FOLLOWING_BATCH",
    users: validateFollowingUsers(event.data.users)
  });
});
```

Reject oversized, malformed, or non-normalized batches.

- [ ] **Step 5: Implement SW sync coordination**

`SYNC_START` must:
1. reject if queue is running/cooldown;
2. locate or open the signed-in user’s Following page;
3. persist `syncMeta.status = "running"`;
4. send `SCROLL_SESSION_START`.

Incoming batches merge by `userId`, preserve newer `syncedAt`, and update progress. Pause/stop reasons persist.

- [ ] **Step 6: Run focused verification**

Run:

```bash
npm test -- tests/content/scroll-controller.test.ts tests/background/sync-coordinator.test.ts
npm run typecheck
```

Expected: PASS.

---

### Task 6: Implement the Conservative Unfollow State Machine

**Files:**
- Create: `src/background/queue.ts`
- Create: `src/background/tab-router.ts`
- Test: `tests/background/queue.test.ts`

**Interfaces:**
- Produces `startQueue(state, userIds, now)`, `planNext(queue, settings, now, random)`, `recordResult(state, result, now)`, `pauseQueue`, and `stopQueue`.
- Alarm name is exactly `follow-gate:unfollow-tick`.

- [ ] **Step 1: Write state-machine tests**

Cover:
- candidates must exist and exclude whitelist
- explicit selected IDs only
- one pending/in-flight item at a time
- Safe/Balance/custom intervals and hard clamps
- hourly/day/session cap stops
- active-hours hold
- persisted `nextAt`
- 401/403/429-equivalent result → 60-minute cooldown
- three consecutive failures → cooldown
- one transient retry, no interval shortening
- account mismatch → stopped
- queue blocks sync

- [ ] **Step 2: Implement queue transitions as pure functions**

```ts
export interface QueuePlan {
  action: "execute" | "wait" | "pause" | "complete";
  nextAt: number | null;
  reason?: QueuePauseReason;
  target?: FollowingUser;
}
```

Use injected `random()` so interval selection is testable. Purge timestamps older than 24 hours for hourly/day quota calculations while preserving audit history separately.

- [ ] **Step 3: Implement alarm scheduling**

Always persist `nextAt` before creating:

```ts
await chrome.alarms.create("follow-gate:unfollow-tick", {
  when: nextAt
});
```

On service-worker restart or alarm event, reload state and recompute. Never execute early if `Date.now() < nextAt`.

- [ ] **Step 4: Implement tab routing**

Use one dedicated visible X tab for write operations. Navigate it to `https://x.com/{handle}`, wait for content readiness, then issue one `UNFOLLOW_ONE`. Do not create parallel tabs. If no suitable active X context exists, pause with `missing-tab`.

- [ ] **Step 5: Run focused verification**

Run:

```bash
npm test -- tests/background/queue.test.ts
npm run typecheck
```

Expected: PASS.

---

### Task 7: Perform One Unfollow Through Visible X UI

**Files:**
- Create: `src/content/unfollow-driver.ts`
- Test: `tests/content/unfollow-driver.test.ts`

**Interfaces:**
- Produces `unfollowOne(target, document, account): Promise<UnfollowResult>`.
- Never calls X friendship/GraphQL endpoints directly.

- [ ] **Step 1: Write DOM-fixture tests**

Test:
- target profile identity must match queue target handle
- signed-in account must match queue owner
- locate “Following” button using stable `data-testid` first, accessible name fallback second
- click opens confirmation dialog
- click exact unfollow confirmation
- already not following returns an idempotent `already-unfollowed`
- login challenge, suspicious activity prompt, missing controls, timeout, or mismatched target return safe failure without additional clicks

- [ ] **Step 2: Implement a strict two-click driver**

```ts
export async function unfollowOne(
  target: FollowingUser,
  env: UnfollowEnvironment
): Promise<UnfollowResult> {
  // 1. Verify account and profile.
  // 2. Locate and click the Following control once.
  // 3. Wait for a matching confirmation dialog.
  // 4. Click the destructive confirmation once.
  // 5. Verify the page changed to Follow.
  // Any ambiguity returns a failure and never guesses.
}
```

Use bounded MutationObserver waits (e.g. 10 seconds), not fixed rapid polling. No synthetic repeated clicks, no DOM mutation beyond normal control activation.

- [ ] **Step 3: Map page outcomes to breaker-safe result codes**

Return typed codes:

```ts
type UnfollowResultCode =
  | "success"
  | "already-unfollowed"
  | "auth-required"
  | "account-mismatch"
  | "challenge"
  | "rate-limited"
  | "target-mismatch"
  | "control-missing"
  | "confirmation-missing"
  | "verification-failed";
```

`auth-required`, `challenge`, and `rate-limited` are immediate circuit-breaker results.

- [ ] **Step 4: Run focused verification**

Run:

```bash
npm test -- tests/content/unfollow-driver.test.ts
npm run typecheck
```

Expected: PASS and tests assert no more than two clicks per attempt.

---

### Task 8: Wire the MV3 Service Worker

**Files:**
- Create: `src/background/index.ts`
- Modify: `src/content/isolated.ts`
- Test: `tests/background/index.test.ts`

**Interfaces:**
- Registers `runtime.onMessage`, `alarms.onAlarm`, `action.onClicked`, `tabs.onUpdated`, and `runtime.onInstalled` synchronously at module top level.
- Opens the Side Panel from the extension action.

- [ ] **Step 1: Write listener-routing tests**

Mock Chrome APIs and assert:
- all listeners register on module import
- async message handler returns `true`
- alarm only handles the exact queue alarm name
- unknown messages yield typed error, not throw
- startup does not auto-run a queue that is paused/stopped/cooldown

- [ ] **Step 2: Implement top-level listener registration**

```ts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error: unknown) =>
      sendResponse({ ok: false, error: toPublicError(error) })
    );
  return true;
});
```

Do not place listener registration inside an async initializer.

- [ ] **Step 3: Wire coordinator, queue, storage, and content results**

After every state mutation, rely on `chrome.storage.onChanged` for Side Panel updates. Avoid maintaining a second UI-specific state cache in the worker.

- [ ] **Step 4: Verify worker resilience**

Run:

```bash
npm test -- tests/background/index.test.ts tests/background/queue.test.ts
npm run build
```

Expected: PASS; no global mutable queue state except the storage update serialization chain.

---

### Task 9: Build the Side Panel Design System and Insight Flow

**Files:**
- Create: `src/sidepanel/index.html`
- Create: `src/sidepanel/main.tsx`
- Create: `src/sidepanel/App.tsx`
- Create: `src/sidepanel/styles.css`
- Create: `src/sidepanel/hooks/useExtensionState.ts`
- Create: `src/sidepanel/components/AppShell.tsx`
- Create: `src/sidepanel/components/StatusBanner.tsx`
- Create: `src/sidepanel/views/InsightView.tsx`
- Test: `tests/sidepanel/App.test.tsx`

**Interfaces:**
- `useExtensionState()` hydrates with `STATE_GET`, then follows `chrome.storage.onChanged`.
- Insight emits only typed `SYNC_START`, `SYNC_PAUSE`, and `SYNC_STOP`.

- [ ] **Step 1: Write UI state tests**

Test Chinese copy and behavior for:
- loading / unauthenticated / ready
- no sync yet
- syncing with live count and pause
- hidden-tab pause
- sync complete/stalled/budget reached
- queue-running mutual exclusion

- [ ] **Step 2: Define visual tokens in Tailwind CSS**

Use a dark neutral system:

```css
@import "tailwindcss";

@theme {
  --color-bg: #0a0a0b;
  --color-surface: #151517;
  --color-surface-raised: #1d1d20;
  --color-border: #2a2a2e;
  --color-text: #f5f5f5;
  --color-muted: #9a9aa1;
  --color-accent: #1d9bf0;
  --color-danger: #f4212e;
  --radius-panel: 14px;
}
```

Use system UI typography for zero remote font dependency. Preserve visible keyboard focus, ≥44px interactive targets, and WCAG AA contrast.

- [ ] **Step 3: Implement the application shell**

Top bar: Follow Gate + login status. Bottom persistent safety status: preset and today count/cap. Main navigation: 洞察 / 清理 / 设置.

- [ ] **Step 4: Implement Insight**

Show synced count, known non-mutual count, mutual rate only over known relationships, and a clear unknown count when parser lacks relationship data. Sync CTA explains “将打开关注列表并渐进滚动采集”.

- [ ] **Step 5: Verify UI**

Run:

```bash
npm test -- tests/sidepanel/App.test.tsx
npm run typecheck
```

Expected: PASS.

---

### Task 10: Build Cleanup, Confirmation, Queue Progress, Settings, and Audit UI

**Files:**
- Create: `src/sidepanel/views/CleanupView.tsx`
- Create: `src/sidepanel/views/SettingsView.tsx`
- Create: `src/sidepanel/components/ConfirmQueueDialog.tsx`
- Modify: `src/sidepanel/App.tsx`
- Modify: `tests/sidepanel/App.test.tsx`

**Interfaces:**
- Cleanup emits `QUEUE_START` only after confirmation.
- Settings emits clamped `SETTINGS_UPDATE` and `WHITELIST_UPDATE`.

- [ ] **Step 1: Add failing cleanup tests**

Verify:
- candidates exclude whitelist and unknown relationships
- default select-all applies only to visible eligible candidates
- adding whitelist removes candidate immediately
- confirmation displays count, preset, interval band, and approximate duration
- Start is disabled when zero selected, sync running, unauthenticated, or cooldown
- pause/stop and countdown are always visible while running

- [ ] **Step 2: Implement candidate list and whitelist interaction**

Use a flat virtualizable list boundary, not nested cards. Each row contains avatar, name, handle, relationship label, checkbox, and whitelist action.

- [ ] **Step 3: Implement explicit confirmation**

Confirmation copy must state that X may still rate-limit or restrict the account and that no automation can guarantee zero risk. Require a user click on “确认并开始”.

- [ ] **Step 4: Implement queue progress and breaker banner**

Display current target, remaining count, next action countdown from persisted `nextAt`, today/hour/session counts, and Pause/Stop. Cooldown banner includes reason and exact local resume time; it must not offer “ignore and continue”.

- [ ] **Step 5: Implement settings and audit**

Safe is default. Custom fields show hard-limit helper text and clamp on save. Audit rows show local timestamp, target, result, and public-safe code; never show headers/tokens/raw X payload.

- [ ] **Step 6: Verify all Side Panel states**

Run:

```bash
npm test -- tests/sidepanel/App.test.tsx
npm run typecheck
```

Expected: PASS.

---

### Task 11: Integration Hardening, Manual Acceptance, and Documentation

**Files:**
- Create: `README.md`
- Create: `docs/manual-test-checklist.md`
- Modify: any source/test file only when a failure is found

**Interfaces:**
- Produces a loadable unpacked extension and repeatable manual acceptance checklist.

- [ ] **Step 1: Run the full automated gate**

Run:

```bash
npm run format:check
npm run lint
npm run typecheck
npm run test
npm run build
```

Expected: every command exits 0.

- [ ] **Step 2: Document local installation and privacy**

README must include:
- `npm install`, `npm run build`
- Chrome → Extensions → Developer mode → Load unpacked → `dist`
- local-only data statement
- exact permissions and reasons
- “cannot guarantee zero restriction risk” warning
- Safe preset recommendation
- recovery steps: pause, wait, reload extension, never export cookies

- [ ] **Step 3: Execute read-only manual acceptance first**

Checklist:
1. Open signed-in X and Side Panel.
2. Start sync; confirm Following tab opens/focuses.
3. Observe varied progressive scrolling.
4. Hide tab ≥45s; verify pause.
5. Resume and verify deduped progress.
6. Verify no extension-owned Following pagination in DevTools.
7. Verify candidates and whitelist behavior.
8. Restart service worker; verify persisted state.

- [ ] **Step 4: Execute minimum-risk write acceptance**

Only after read-only acceptance passes:
1. Use a controlled test account or one explicitly expendable target.
2. Set Safe preset and select exactly one candidate.
3. Confirm the preview.
4. Verify profile navigation, one Following click, one confirmation click.
5. Verify audit entry and no second action before `nextAt`.
6. Test Pause/Stop without issuing another real unfollow.

Do not test bulk unfollow against a real account.

- [ ] **Step 5: Inspect the production artifact**

Confirm:
- manifest has no `cookies`, `<all_urls>`, `webRequest`, or remote code
- source maps do not include captured real user data
- fixture is redacted
- no tokens, headers, cookie names/values, or raw network payloads in logs
- `dist` loads without MV3 warnings

- [ ] **Step 6: Final verification**

Run the full automated gate again after any manual-test fix.

Expected: all checks pass, and the manual checklist records the Chrome version and observed result for each item.

---

## Self-Review Result

- Spec coverage: architecture, progressive scrolling, local storage, P0 rule, whitelist, safety presets/floors, mutual exclusion, circuit breaker, Side Panel, error handling, and testing all map to explicit tasks.
- Security/privacy: no cookie permission, no remote service, no raw response persistence, no direct friendship endpoint.
- Type consistency: message names and domain types are introduced before use; queue and UI consume the same persisted `ExtensionState`.
- Scope: P1, P2, CLI, cloud, store publication, and multi-account concurrency remain excluded.
- No implementation placeholders are intentionally left; the only live-X-dependent work is capturing a redacted response fixture and validating stable UI selectors during manual acceptance.
