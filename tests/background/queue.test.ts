import {
  applyUnfollowResult,
  dismissQueueCooldown,
  enforceQueueOwner,
  FAILURE_BREAKER_THRESHOLD,
  isSyncBlockingQueue,
  isUnfollowAlarm,
  MAX_ATTEMPTS_PER_ITEM,
  MAX_AUDIT_ENTRIES,
  MAX_SELECTED_IDS,
  pauseQueue,
  pauseUnfollowQueue,
  planNext,
  reconcileQueue,
  recordResult,
  runQueueTick,
  selectQueueTargets,
  startQueue,
  startUnfollowQueue,
  stopQueue,
  stopUnfollowQueue,
  UNFOLLOW_ALARM_NAME,
} from "@/background/queue";
import { isQueueBlockingSync } from "@/background/sync-coordinator";
import { createDefaultState, STATE_STORAGE_KEY } from "@/shared/defaults";
import type { ExtensionMessage } from "@/shared/messages";
import { COOLDOWN_MS, DAY_MS, HOUR_MS, MINUTE_MS, UNFOLLOW_WATCHDOG_MS } from "@/shared/safety";
import type {
  ExtensionState,
  FollowingUser,
  Settings,
  SyncMeta,
  UnfollowQueue,
  UnfollowQueueItem,
  UnfollowResult,
  UnfollowResultCode,
} from "@/shared/types";

/** Local-time helper so active-hours assertions are timezone independent. */
function localTime(hour: number, minute = 0): number {
  return new Date(2026, 7, 17, hour, minute, 0, 0).getTime();
}

const NOW = localTime(12);
const OWNER = { userId: "9", handle: "self" };
const WATCHDOG_MS = UNFOLLOW_WATCHDOG_MS;

function user(overrides: Partial<FollowingUser> = {}): FollowingUser {
  return {
    userId: "1",
    handle: "alice",
    name: "Alice",
    avatarUrl: null,
    followedBy: false,
    syncedAt: NOW - MINUTE_MS,
    ...overrides,
  };
}

function settings(overrides: Partial<Settings> = {}): Settings {
  return { ...createDefaultState().settings, ...overrides };
}

function syncMeta(overrides: Partial<SyncMeta> = {}): SyncMeta {
  return { ...createDefaultState().syncMeta, ...overrides };
}

function queue(overrides: Partial<UnfollowQueue> = {}): UnfollowQueue {
  return { ...createDefaultState().unfollowQueue, ...overrides };
}

function item(overrides: Partial<UnfollowQueueItem> = {}): UnfollowQueueItem {
  return {
    userId: "1",
    handle: "alice",
    status: "pending",
    attempts: 0,
    lastCode: null,
    ...overrides,
  };
}

/** A queue mid-session: one item pending, owner matching, quotas untouched. */
function runningQueue(overrides: Partial<UnfollowQueue> = {}): UnfollowQueue {
  return queue({
    status: "running",
    items: [item(), item({ userId: "2", handle: "bob" })],
    cursor: 0,
    nextAt: NOW - 1,
    sessionStartedAt: NOW - 10 * MINUTE_MS,
    ownerUserId: OWNER.userId,
    ...overrides,
  });
}

function baseState(overrides: Partial<ExtensionState> = {}): ExtensionState {
  return {
    ...createDefaultState(),
    session: { account: OWNER, checkedAt: NOW - MINUTE_MS },
    following: {
      "1": user(),
      "2": user({ userId: "2", handle: "bob" }),
      "3": user({ userId: "3", handle: "carol" }),
    },
    ...overrides,
  };
}

function result(overrides: Partial<UnfollowResult> = {}): UnfollowResult {
  return { userId: "1", handle: "alice", ok: true, code: "success", ...overrides };
}

function inFlightState(overrides: Partial<UnfollowQueue> = {}): ExtensionState {
  return baseState({
    unfollowQueue: runningQueue({
      items: [item({ status: "in-flight", attempts: 1 }), item({ userId: "2", handle: "bob" })],
      nextAt: NOW + WATCHDOG_MS,
      ...overrides,
    }),
  });
}

interface FakeTab {
  id: number;
  url: string;
  active: boolean;
  status: string;
}

/**
 * One shared operation log across storage, alarms, and tabs, so ordering rules
 * ("persist `nextAt` before arming the alarm", "never send before persisting")
 * can be asserted instead of assumed.
 */
function createChromeMock(
  initialTabs: Array<Partial<FakeTab>> = [{ id: 7, url: "https://x.com/home" }],
) {
  const order: string[] = [];
  const records = new Map<string, unknown>();
  let nextId = 100;
  const tabs: FakeTab[] = initialTabs.map((tab) => ({
    id: tab.id ?? nextId++,
    url: tab.url ?? "https://x.com/home",
    active: tab.active ?? false,
    status: tab.status ?? "complete",
  }));
  const messages: Array<{ tabId: number; message: ExtensionMessage }> = [];
  const updates: Array<{ tabId: number; url?: string; active?: boolean }> = [];
  const alarms = new Map<string, number>();
  let deliverable = true;

  const storage = {
    local: {
      get: vi.fn(async (key: string) => {
        const value = records.get(key);

        return value === undefined ? {} : { [key]: structuredClone(value) };
      }),
      set: vi.fn(async (items: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(items)) {
          records.set(key, structuredClone(value));
          const state = value as ExtensionState;
          order.push(
            `persist:status=${state.unfollowQueue.status},nextAt=${String(state.unfollowQueue.nextAt)}`,
          );
        }
      }),
    },
  };

  const alarmsApi = {
    create: vi.fn(async (name: string, info: { when: number }) => {
      alarms.set(name, info.when);
      order.push(`alarm:${name}@${info.when}`);
    }),
    clear: vi.fn(async (name: string) => {
      alarms.delete(name);
      order.push(`clear:${name}`);

      return true;
    }),
  };

  const tabsApi = {
    query: vi.fn(async () => tabs.map((tab) => ({ ...tab }))),
    get: vi.fn(async (tabId: number) => {
      const tab = tabs.find((candidate) => candidate.id === tabId);
      if (tab === undefined) {
        throw new Error(`No tab with id: ${tabId}.`);
      }

      return { ...tab };
    }),
    create: vi.fn(async () => {
      throw new Error("the unfollow path must never open a tab");
    }),
    update: vi.fn(async (tabId: number, properties: { url?: string; active?: boolean }) => {
      updates.push({ tabId, ...properties });
      const tab = tabs.find((candidate) => candidate.id === tabId);
      if (tab === undefined) {
        throw new Error(`No tab with id: ${tabId}.`);
      }

      if (properties.url !== undefined) {
        tab.url = properties.url;
      }
      if (properties.active !== undefined) {
        tab.active = properties.active;
      }

      return { ...tab };
    }),
    sendMessage: vi.fn(async (tabId: number, message: ExtensionMessage) => {
      order.push(`send:${message.type}`);
      if (!deliverable) {
        throw new Error("Could not establish connection. Receiving end does not exist.");
      }

      messages.push({ tabId, message });

      return { accepted: true };
    }),
  };

  return {
    storage,
    alarmsApi,
    tabsApi,
    order,
    messages,
    updates,
    alarms,
    breakDelivery() {
      deliverable = false;
    },
    seed(value: ExtensionState) {
      records.set(STATE_STORAGE_KEY, structuredClone(value));
      order.length = 0;
      storage.local.set.mockClear();
    },
    persisted(): ExtensionState {
      const value = records.get(STATE_STORAGE_KEY);
      if (value === undefined) {
        throw new Error("nothing was persisted");
      }

      return value as ExtensionState;
    },
    persistedQueue(): UnfollowQueue {
      return this.persisted().unfollowQueue;
    },
  };
}

let chromeMock: ReturnType<typeof createChromeMock>;

function install(mock = createChromeMock()) {
  chromeMock = mock;
  vi.stubGlobal("chrome", {
    storage: { local: mock.storage.local },
    alarms: mock.alarmsApi,
    tabs: mock.tabsApi,
  });
}

/** Readiness poll without real timers. */
const routeOptions = { wait: async (): Promise<void> => undefined };

beforeEach(() => {
  install();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("selectQueueTargets", () => {
  it("keeps only the explicitly selected ids, in the order they were selected", () => {
    const targets = selectQueueTargets(baseState(), ["2", "1"]);

    expect(targets.map((target) => target.userId)).toEqual(["2", "1"]);
  });

  it("drops ids the current relationship no longer makes candidates", () => {
    const state = baseState({
      following: {
        "1": user(),
        "2": user({ userId: "2", handle: "bob", followedBy: true }),
        "3": user({ userId: "3", handle: "carol", followedBy: null }),
      },
    });

    expect(selectQueueTargets(state, ["1", "2", "3"]).map((target) => target.userId)).toEqual([
      "1",
    ]);
  });

  it("drops whitelisted ids whether the entry matches by handle or by id", () => {
    const state = baseState({ whitelist: [{ handle: "Bob" }, { userId: "3" }] });

    expect(selectQueueTargets(state, ["1", "2", "3"]).map((target) => target.userId)).toEqual([
      "1",
    ]);
  });

  it("drops unknown ids and duplicates", () => {
    const targets = selectQueueTargets(baseState(), ["1", "1", "999", "", " 2 "]);

    expect(targets.map((target) => target.userId)).toEqual(["1", "2"]);
  });

  it("rejects a selection too large to be a user decision", () => {
    const oversized = Array.from({ length: MAX_SELECTED_IDS + 1 }, () => "1");

    expect(selectQueueTargets(baseState(), oversized)).toEqual([]);
    expect(selectQueueTargets(baseState(), "1" as unknown as string[])).toEqual([]);
  });

  it("ignores a stale candidate snapshot and re-derives from the following map", () => {
    const state = baseState({
      following: { "3": user({ userId: "3", handle: "carol", followedBy: true }) },
      candidates: ["3"],
    });

    expect(selectQueueTargets(state, ["3"])).toEqual([]);
  });
});

describe("startQueue", () => {
  it("starts a session owned by the signed-in account", () => {
    const outcome = startQueue(baseState(), ["1", "2"], NOW);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }

    expect(outcome.state.unfollowQueue).toEqual(
      queue({
        status: "running",
        items: [item(), item({ userId: "2", handle: "bob" })],
        cursor: 0,
        nextAt: null,
        sessionStartedAt: NOW,
        actionTimestamps: [],
        cooldownUntil: null,
        pauseReason: null,
        consecutiveFailures: 0,
        ownerUserId: OWNER.userId,
      }),
    );
  });

  it("refuses to start without a confirmed signed-in account", () => {
    const state = baseState({ session: { account: null, checkedAt: NOW } });

    expect(startQueue(state, ["1"], NOW)).toEqual({ ok: false, reason: "auth-required" });
  });

  it("refuses to start when nothing survives re-validation", () => {
    const state = baseState({ whitelist: [{ handle: "alice" }] });

    expect(startQueue(state, ["1"], NOW)).toEqual({ ok: false, reason: "no-candidates" });
    expect(startQueue(baseState(), [], NOW)).toEqual({ ok: false, reason: "no-candidates" });
  });

  it("refuses to start while a scroll round can still resume on its own", () => {
    const running = baseState({ syncMeta: syncMeta({ status: "running" }) });
    expect(startQueue(running, ["1"], NOW)).toEqual({ ok: false, reason: "sync-running" });

    const hidden = baseState({
      syncMeta: syncMeta({ status: "paused", pauseReason: "hidden" }),
    });
    expect(startQueue(hidden, ["1"], NOW)).toEqual({ ok: false, reason: "sync-running" });
  });

  it("starts once the scroll round has ended", () => {
    for (const status of ["idle", "completed", "stopped"] as const) {
      const state = baseState({ syncMeta: syncMeta({ status }) });

      expect(startQueue(state, ["1"], NOW).ok, status).toBe(true);
    }
  });

  it("starts after a round that only an explicit restart could resume", () => {
    for (const pauseReason of ["budget", "stalled", "user", "auth"] as const) {
      const state = baseState({ syncMeta: syncMeta({ status: "paused", pauseReason }) });

      expect(startQueue(state, ["1"], NOW).ok, pauseReason).toBe(true);
    }
  });

  it("refuses to restart a queue that is already working", () => {
    const running = baseState({ unfollowQueue: runningQueue() });
    expect(startQueue(running, ["1"], NOW)).toEqual({ ok: false, reason: "queue-active" });

    const inFlight = baseState({
      unfollowQueue: queue({ status: "paused", items: [item({ status: "in-flight" })] }),
    });
    expect(startQueue(inFlight, ["1"], NOW)).toEqual({ ok: false, reason: "queue-active" });
  });

  it("refuses to start while the breaker cooldown is still open", () => {
    const state = baseState({
      unfollowQueue: queue({ status: "cooldown", cooldownUntil: NOW + 1 }),
    });

    expect(startQueue(state, ["1"], NOW)).toEqual({ ok: false, reason: "cooldown" });
  });

  it("keeps the last 24 hours of quota history so a restart cannot reset the caps", () => {
    const recent = NOW - 30 * MINUTE_MS;
    const state = baseState({
      unfollowQueue: queue({
        status: "completed",
        actionTimestamps: [NOW - DAY_MS - 1, recent],
      }),
    });

    const outcome = startQueue(state, ["1"], NOW);

    expect(outcome.ok && outcome.state.unfollowQueue.actionTimestamps).toEqual([recent]);
  });

  it("never adopts an account that did not select the targets", () => {
    const state = baseState({
      session: { account: { userId: "42", handle: "other" }, checkedAt: NOW },
    });

    const outcome = startQueue(state, ["1"], NOW);

    expect(outcome.ok && outcome.state.unfollowQueue.ownerUserId).toBe("42");
  });

  it("blocks sync as soon as it is running", () => {
    const outcome = startQueue(baseState(), ["1"], NOW);

    expect(outcome.ok && isQueueBlockingSync(outcome.state.unfollowQueue, NOW)).toBe(true);
  });
});

describe("isSyncBlockingQueue", () => {
  it("treats a running round, and only a self-resuming pause, as owning the tab", () => {
    expect(isSyncBlockingQueue(syncMeta({ status: "running" }))).toBe(true);
    expect(isSyncBlockingQueue(syncMeta({ status: "paused", pauseReason: "hidden" }))).toBe(true);
    expect(isSyncBlockingQueue(syncMeta({ status: "idle" }))).toBe(false);
    expect(isSyncBlockingQueue(syncMeta({ status: "completed" }))).toBe(false);
    expect(isSyncBlockingQueue(syncMeta({ status: "stopped" }))).toBe(false);
  });

  it("releases the tab once the round needs an explicit restart", () => {
    // `budget` is how a finished round normally ends: reaching the sync target
    // must not leave the unfollow queue blocked forever.
    for (const pauseReason of ["budget", "stalled", "user", "auth"] as const) {
      expect(isSyncBlockingQueue(syncMeta({ status: "paused", pauseReason })), pauseReason).toBe(
        false,
      );
    }
  });
});

describe("planNext", () => {
  it("dispatches the first unfollow immediately so the profile dwell is the only wait", () => {
    const plan = planNext(runningQueue({ nextAt: null }), settings(), NOW, () => 0);

    expect(plan).toEqual({
      action: "execute",
      nextAt: NOW + WATCHDOG_MS,
      target: item(),
    });
  });

  it("dispatches the next unfollow immediately after one completes", () => {
    const plan = planNext(
      runningQueue({
        nextAt: null,
        items: [
          item({ status: "done" }),
          item({ userId: "2", handle: "bob", status: "pending" }),
        ],
      }),
      settings(),
      NOW,
      () => 0,
    );

    expect(plan).toEqual({
      action: "execute",
      nextAt: NOW + WATCHDOG_MS,
      target: item({ userId: "2", handle: "bob", status: "pending" }),
    });
  });

  it("arms a fixed watchdog rather than sampling the interval band", () => {
    const band = [0, 0.5, 1].map(
      (sample) => planNext(runningQueue({ nextAt: null }), settings(), NOW, () => sample).nextAt,
    );

    expect(band).toEqual([NOW + WATCHDOG_MS, NOW + WATCHDOG_MS, NOW + WATCHDOG_MS]);
  });

  it("does not defer the first unfollow overnight on the default settings", () => {
    const night = localTime(23, 30);
    const plan = planNext(runningQueue({ nextAt: null }), settings(), night, () => 0);

    expect(plan).toMatchObject({ action: "execute", nextAt: night + WATCHDOG_MS });
  });

  it("executes the first pending item once the schedule is due", () => {
    const plan = planNext(runningQueue({ nextAt: NOW }), settings(), NOW, () => 0);

    expect(plan).toMatchObject({ action: "execute", target: item() });
  });

  it("arms the watchdog when it hands out an execution", () => {
    const plan = planNext(runningQueue({ nextAt: NOW }), settings(), NOW, () => 0);

    expect(plan.nextAt).toBe(NOW + WATCHDOG_MS);
  });

  it("never executes before the persisted schedule", () => {
    const plan = planNext(runningQueue({ nextAt: NOW + 1 }), settings(), NOW, () => 0);

    expect(plan).toMatchObject({ action: "wait", nextAt: NOW + 1 });
  });

  it("keeps a single flight: an in-flight item blocks every execution", () => {
    const plan = planNext(
      runningQueue({
        items: [item({ status: "in-flight", attempts: 1 }), item({ userId: "2", handle: "bob" })],
        nextAt: NOW + 1,
      }),
      settings(),
      NOW,
      () => 0,
    );

    expect(plan).toMatchObject({ action: "wait", target: { userId: "1", status: "in-flight" } });
  });

  it("stops the session when the session cap is reached", () => {
    const sessionStartedAt = NOW - 20 * MINUTE_MS;
    const plan = planNext(
      runningQueue({
        sessionStartedAt,
        actionTimestamps: Array.from({ length: 10 }, (_, index) => sessionStartedAt + index),
      }),
      settings(),
      NOW,
      () => 0,
    );

    expect(plan).toEqual({ action: "pause", nextAt: null, reason: "session-cap", target: item() });
  });

  it("holds until the hourly window frees a slot", () => {
    const oldest = NOW - 50 * MINUTE_MS;
    const plan = planNext(
      runningQueue({
        sessionStartedAt: NOW,
        actionTimestamps: [
          oldest,
          NOW - 40 * MINUTE_MS,
          NOW - 30 * MINUTE_MS,
          NOW - 20 * MINUTE_MS,
          NOW - MINUTE_MS,
        ],
      }),
      settings(),
      NOW,
      () => 0,
    );

    expect(plan).toMatchObject({ action: "wait", nextAt: oldest + HOUR_MS, reason: "hourly-cap" });
  });

  it("holds until the daily window frees a slot", () => {
    const oldest = NOW - 20 * HOUR_MS;
    const plan = planNext(
      runningQueue({
        sessionStartedAt: NOW,
        actionTimestamps: [oldest, NOW - 3 * HOUR_MS],
      }),
      settings({ preset: "custom", hourlyCap: 12, dailyCap: 2, sessionCap: 20 }),
      NOW,
      () => 0,
    );

    expect(plan).toMatchObject({ action: "wait", nextAt: oldest + DAY_MS, reason: "daily-cap" });
  });

  it("holds outside the active-hours window and points at the next opening", () => {
    const night = localTime(3);

    const plan = planNext(
      runningQueue({ nextAt: night }),
      settings({ activeHours: { enabled: true, start: "09:00", end: "23:00" } }),
      night,
      () => 0,
    );

    expect(plan).toMatchObject({
      action: "wait",
      nextAt: localTime(9),
      reason: "outside-active-hours",
    });
  });

  it("completes when no item is left to work on", () => {
    const plan = planNext(
      runningQueue({
        items: [item({ status: "done" }), item({ userId: "2", handle: "bob", status: "failed" })],
      }),
      settings(),
      NOW,
      () => 0,
    );

    expect(plan).toEqual({ action: "complete", nextAt: null });
  });

  it("waits out a breaker cooldown and never executes inside it", () => {
    const cooldownUntil = NOW + COOLDOWN_MS;
    const plan = planNext(
      runningQueue({ status: "cooldown", cooldownUntil, pauseReason: "rate-limited", nextAt: NOW }),
      settings(),
      NOW,
      () => 0,
    );

    expect(plan).toEqual({
      action: "wait",
      nextAt: cooldownUntil,
      reason: "rate-limited",
      target: undefined,
    });
  });

  it("demotes an expired cooldown to a pause the user has to leave", () => {
    const plan = planNext(
      runningQueue({ status: "cooldown", cooldownUntil: NOW, pauseReason: "rate-limited" }),
      settings(),
      NOW,
      () => 0,
    );

    expect(plan).toEqual({
      action: "pause",
      nextAt: null,
      reason: "rate-limited",
      target: undefined,
    });
  });

  it("never executes for a queue that is not running", () => {
    for (const status of ["idle", "paused", "stopped"] as const) {
      const plan = planNext(runningQueue({ status, nextAt: NOW - 1 }), settings(), NOW, () => 0);

      expect(plan.action, status).toBe("pause");
    }

    expect(planNext(runningQueue({ status: "completed" }), settings(), NOW, () => 0)).toEqual({
      action: "complete",
      nextAt: null,
    });
  });
});

describe("recordResult", () => {
  it("records a success, spends quota, and clears the schedule", () => {
    const next = recordResult(inFlightState(), result(), NOW);

    expect(next.unfollowQueue).toMatchObject({
      status: "running",
      items: [
        { userId: "1", status: "done", attempts: 1, lastCode: "success" },
        { userId: "2", status: "pending" },
      ],
      cursor: 1,
      nextAt: null,
      actionTimestamps: [NOW],
      consecutiveFailures: 0,
    });
    expect(next.auditLog).toEqual([
      { at: NOW, userId: "1", handle: "alice", ok: true, code: "success" },
    ]);
    expect(next.following["1"]).toBeUndefined();
    expect(next.candidates).toEqual(["2", "3"]);
  });

  it("treats an already-unfollowed target as a completed action", () => {
    const next = recordResult(inFlightState(), result({ code: "already-unfollowed" }), NOW);

    expect(next.unfollowQueue.items[0]).toMatchObject({
      status: "done",
      lastCode: "already-unfollowed",
    });
    expect(next.unfollowQueue.actionTimestamps).toEqual([NOW]);
    expect(next.following["1"]).toBeUndefined();
  });

  it("does not schedule the next attempt itself", () => {
    const next = recordResult(inFlightState(), result(), NOW);

    expect(next.unfollowQueue.nextAt).toBeNull();
    expect(planNext(next.unfollowQueue, next.settings, NOW, () => 0)).toMatchObject({
      action: "execute",
      nextAt: NOW + WATCHDOG_MS,
    });
  });

  it("ignores a result that does not belong to the in-flight item", () => {
    const state = inFlightState();

    expect(recordResult(state, result({ userId: "2", handle: "bob" }), NOW)).toBe(state);
  });

  it("ignores a result when nothing is in flight", () => {
    const state = baseState({ unfollowQueue: runningQueue() });

    expect(recordResult(state, result(), NOW)).toBe(state);
  });

  it("still books an action the page completed after the user paused", () => {
    const paused = pauseQueue(inFlightState(), "user");

    const next = recordResult(paused, result(), NOW);

    // The action really happened, so it must cost quota and appear in the log —
    // without reviving the session the user stopped.
    expect(next.unfollowQueue).toMatchObject({
      status: "paused",
      pauseReason: "user",
      nextAt: null,
      actionTimestamps: [NOW],
      items: [
        { userId: "1", status: "done", lastCode: "success" },
        { userId: "2", status: "pending" },
      ],
    });
    expect(next.auditLog).toHaveLength(1);

    // A duplicate copy of the same report must not be booked twice.
    expect(recordResult(next, result(), NOW + 1)).toBe(next);
  });

  it("audits a late failure without touching the breaker of a stopped session", () => {
    const stopped = stopQueue(inFlightState());

    const next = recordResult(stopped, result({ ok: false, code: "control-missing" }), NOW);

    expect(next.unfollowQueue).toMatchObject({
      status: "stopped",
      actionTimestamps: [],
      consecutiveFailures: 0,
      items: [
        { userId: "1", status: "failed", lastCode: "control-missing" },
        { userId: "2", status: "pending" },
      ],
    });
    expect(next.auditLog).toEqual([
      { at: NOW, userId: "1", handle: "alice", ok: false, code: "control-missing" },
    ]);
  });

  it("derives the outcome from the code and never trusts the reported flag", () => {
    const next = recordResult(inFlightState(), result({ ok: true, code: "rate-limited" }), NOW);

    expect(next.unfollowQueue).toMatchObject({
      status: "cooldown",
      cooldownUntil: NOW + COOLDOWN_MS,
      pauseReason: "rate-limited",
    });
    expect(next.auditLog[0]).toMatchObject({ ok: false, code: "rate-limited" });
  });

  it("treats an unrecognised code as a failed verification", () => {
    const next = recordResult(
      inFlightState(),
      result({ ok: true, code: "totally-fine" as UnfollowResultCode }),
      NOW,
    );

    expect(next.auditLog[0]).toMatchObject({ ok: false, code: "verification-failed" });
    expect(next.unfollowQueue.actionTimestamps).toEqual([]);
  });

  it("audits the stored handle, not the one the page reported", () => {
    const next = recordResult(inFlightState(), result({ handle: "not-alice" }), NOW);

    expect(next.auditLog[0]?.handle).toBe("alice");
  });

  it("breaks the circuit for 60 minutes on an authentication or challenge result", () => {
    for (const code of ["auth-required", "challenge"] as const) {
      const next = recordResult(inFlightState(), result({ ok: false, code }), NOW);

      expect(next.unfollowQueue, code).toMatchObject({
        status: "cooldown",
        cooldownUntil: NOW + 60 * MINUTE_MS,
        pauseReason: "auth-required",
        nextAt: null,
      });
      expect(next.unfollowQueue.items[0], code).toMatchObject({ status: "failed" });
    }
  });

  it("stops the queue on an account mismatch instead of cooling down", () => {
    const next = recordResult(
      inFlightState(),
      result({ ok: false, code: "account-mismatch" }),
      NOW,
    );

    expect(next.unfollowQueue).toMatchObject({
      status: "stopped",
      pauseReason: "account-mismatch",
      cooldownUntil: null,
      nextAt: null,
    });
  });

  it("retries a transient failure exactly once and then skips the target", () => {
    const first = recordResult(
      inFlightState(),
      result({ ok: false, code: "control-missing" }),
      NOW,
    );

    expect(first.unfollowQueue.items[0]).toMatchObject({
      status: "pending",
      attempts: MAX_ATTEMPTS_PER_ITEM - 1,
      lastCode: "control-missing",
    });
    expect(first.unfollowQueue.cursor).toBe(0);

    const retried = baseState({
      unfollowQueue: {
        ...first.unfollowQueue,
        items: first.unfollowQueue.items.map((entry, index) =>
          index === 0 ? { ...entry, status: "in-flight" as const, attempts: 2 } : entry,
        ),
      },
    });
    const second = recordResult(retried, result({ ok: false, code: "control-missing" }), NOW + 1);

    expect(second.unfollowQueue.items[0]).toMatchObject({ status: "failed", attempts: 2 });
    expect(second.unfollowQueue.cursor).toBe(1);
  });

  it("retries a failed item immediately; the profile dwell is the gap", () => {
    const failed = recordResult(
      inFlightState(),
      result({ ok: false, code: "control-missing" }),
      NOW,
    );

    expect(planNext(failed.unfollowQueue, failed.settings, NOW, () => 0)).toMatchObject({
      action: "execute",
      nextAt: NOW + WATCHDOG_MS,
    });
  });

  it("breaks the circuit after three consecutive failures", () => {
    const state = inFlightState({ consecutiveFailures: FAILURE_BREAKER_THRESHOLD - 1 });

    const next = recordResult(state, result({ ok: false, code: "verification-failed" }), NOW);

    expect(next.unfollowQueue).toMatchObject({
      status: "cooldown",
      cooldownUntil: NOW + COOLDOWN_MS,
      pauseReason: "consecutive-failures",
      consecutiveFailures: FAILURE_BREAKER_THRESHOLD,
    });
  });

  it("resets the failure streak on a completed action", () => {
    const state = inFlightState({ consecutiveFailures: 2 });

    expect(recordResult(state, result(), NOW).unfollowQueue.consecutiveFailures).toBe(0);
  });

  it("purges quota history older than 24 hours while the audit log keeps it", () => {
    const stale = NOW - DAY_MS - 1;
    const state = inFlightState({ actionTimestamps: [stale, NOW - HOUR_MS] });
    const withHistory: ExtensionState = {
      ...state,
      auditLog: [{ at: stale, userId: "0", handle: "old", ok: true, code: "success" }],
    };

    const next = recordResult(withHistory, result(), NOW);

    expect(next.unfollowQueue.actionTimestamps).toEqual([NOW - HOUR_MS, NOW]);
    expect(next.auditLog).toHaveLength(2);
    expect(next.auditLog[0]?.at).toBe(stale);
  });

  it("caps the audit log so storage cannot grow without bound", () => {
    const state: ExtensionState = {
      ...inFlightState(),
      auditLog: Array.from({ length: MAX_AUDIT_ENTRIES }, (_, index) => ({
        at: NOW - MAX_AUDIT_ENTRIES + index,
        userId: `${index}`,
        handle: "old",
        ok: true,
        code: "success" as const,
      })),
    };

    const next = recordResult(state, result(), NOW);

    expect(next.auditLog).toHaveLength(MAX_AUDIT_ENTRIES);
    expect(next.auditLog.at(-1)).toMatchObject({ at: NOW, userId: "1" });
  });
});

describe("pauseQueue and stopQueue", () => {
  it("pauses a running queue, clearing the flight and the schedule", () => {
    const next = pauseQueue(inFlightState(), "user");

    expect(next.unfollowQueue).toMatchObject({
      status: "paused",
      pauseReason: "user",
      nextAt: null,
      items: [
        { userId: "1", status: "skipped" },
        { userId: "2", status: "pending" },
      ],
    });
    expect(isQueueBlockingSync(next.unfollowQueue, NOW)).toBe(false);
  });

  it("keeps a user pause when an automatic reason arrives afterwards", () => {
    const paused = pauseQueue(baseState({ unfollowQueue: runningQueue() }), "user");

    expect(pauseQueue(paused, "missing-tab").unfollowQueue.pauseReason).toBe("user");
    expect(pauseQueue(paused, "user").unfollowQueue.pauseReason).toBe("user");
  });

  it("leaves an idle, completed or stopped queue alone", () => {
    for (const status of ["idle", "completed", "stopped"] as const) {
      const state = baseState({ unfollowQueue: queue({ status }) });

      expect(pauseQueue(state, "user"), status).toBe(state);
    }
  });

  it("never lifts a breaker cooldown through pause or stop", () => {
    const cooling = baseState({
      unfollowQueue: queue({
        status: "cooldown",
        cooldownUntil: NOW + COOLDOWN_MS,
        pauseReason: "rate-limited",
      }),
    });

    expect(pauseQueue(cooling, "user").unfollowQueue).toMatchObject({
      status: "cooldown",
      cooldownUntil: NOW + COOLDOWN_MS,
      pauseReason: "rate-limited",
    });
    expect(stopQueue(cooling).unfollowQueue).toMatchObject({
      status: "stopped",
      cooldownUntil: NOW + COOLDOWN_MS,
    });
  });

  it("lifts a breaker cooldown only through an explicit dismiss", () => {
    const cooling = baseState({
      unfollowQueue: queue({
        status: "cooldown",
        cooldownUntil: NOW + COOLDOWN_MS,
        pauseReason: "auth-required",
        consecutiveFailures: 3,
      }),
    });

    const outcome = dismissQueueCooldown(cooling, NOW);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }

    expect(outcome.state.unfollowQueue).toMatchObject({
      status: "stopped",
      cooldownUntil: null,
      pauseReason: null,
      consecutiveFailures: 0,
    });
    expect(isQueueBlockingSync(outcome.state.unfollowQueue, NOW)).toBe(false);
  });

  it("refuses to dismiss when the breaker window is already closed", () => {
    const state = baseState({
      unfollowQueue: queue({
        status: "paused",
        cooldownUntil: NOW - 1,
        pauseReason: "rate-limited",
      }),
    });

    expect(dismissQueueCooldown(state, NOW)).toEqual({ ok: false, reason: "not-cooling" });
  });

  it("stops a queue and releases the tab for sync", () => {
    const next = stopQueue(inFlightState());

    expect(next.unfollowQueue).toMatchObject({
      status: "stopped",
      pauseReason: null,
      nextAt: null,
      items: [
        { userId: "1", status: "skipped" },
        { userId: "2", status: "pending" },
      ],
    });
    expect(isQueueBlockingSync(next.unfollowQueue, NOW)).toBe(false);
  });
});

describe("enforceQueueOwner", () => {
  it("stops the queue when the session account became unknown", () => {
    const state: ExtensionState = {
      ...inFlightState(),
      session: { account: null, checkedAt: NOW },
    };

    const next = enforceQueueOwner(state);

    expect(next.unfollowQueue).toMatchObject({
      status: "stopped",
      pauseReason: "account-mismatch",
      nextAt: null,
      items: [
        { userId: "1", status: "skipped" },
        { userId: "2", status: "pending" },
      ],
    });
  });

  it("stops the queue on a mismatch and never adopts the new account", () => {
    const state: ExtensionState = {
      ...inFlightState(),
      session: { account: { userId: "42", handle: "other" }, checkedAt: NOW },
    };

    const next = enforceQueueOwner(state);

    expect(next.unfollowQueue.status).toBe("stopped");
    expect(next.unfollowQueue.ownerUserId).toBe(OWNER.userId);
  });

  it("leaves a matching owner untouched", () => {
    const state = inFlightState();

    expect(enforceQueueOwner(state)).toBe(state);
  });

  it("ignores a queue that is not working", () => {
    const state: ExtensionState = {
      ...baseState({ unfollowQueue: queue({ status: "idle", ownerUserId: "9" }) }),
      session: { account: null, checkedAt: NOW },
    };

    expect(enforceQueueOwner(state)).toBe(state);
  });
});

describe("reconcileQueue", () => {
  it("fails an in-flight item whose result never arrived instead of repeating the write", () => {
    const state = inFlightState({ nextAt: NOW });

    const next = reconcileQueue(state, NOW);

    expect(next.unfollowQueue.items[0]).toMatchObject({
      status: "failed",
      attempts: 1,
      lastCode: "verification-failed",
    });
    expect(next.unfollowQueue.consecutiveFailures).toBe(1);
    expect(next.auditLog[0]).toMatchObject({ ok: false, code: "verification-failed" });
  });

  it("leaves an in-flight item alone while its result is still due", () => {
    const state = inFlightState({ nextAt: NOW + 1 });

    expect(reconcileQueue(state, NOW)).toBe(state);
  });

  it("skips items that stopped being candidates while the queue ran", () => {
    const state = baseState({
      following: {
        "1": user({ followedBy: true }),
        "2": user({ userId: "2", handle: "bob" }),
      },
      whitelist: [{ handle: "bob" }],
      unfollowQueue: runningQueue(),
    });

    const next = reconcileQueue(state, NOW);

    expect(next.unfollowQueue.items).toEqual([
      item({ status: "skipped" }),
      item({ userId: "2", handle: "bob", status: "skipped" }),
    ]);
  });

  it("stops the queue before anything else when the owner no longer matches", () => {
    const state: ExtensionState = {
      ...inFlightState({ nextAt: NOW }),
      session: { account: null, checkedAt: NOW },
    };

    expect(reconcileQueue(state, NOW).unfollowQueue).toMatchObject({
      status: "stopped",
      pauseReason: "account-mismatch",
    });
  });
});

describe("isUnfollowAlarm", () => {
  it("recognises exactly one alarm name", () => {
    expect(UNFOLLOW_ALARM_NAME).toBe("follow-gate:unfollow-tick");
    expect(isUnfollowAlarm("follow-gate:unfollow-tick")).toBe(true);
    expect(isUnfollowAlarm("follow-gate:unfollow-tick ")).toBe(false);
    expect(isUnfollowAlarm("other")).toBe(false);
  });
});

describe("startUnfollowQueue", () => {
  it("persists the session and dispatches the first unfollow", async () => {
    chromeMock.seed(baseState());

    const outcome = await startUnfollowQueue(["1", "2"], NOW, () => 0, routeOptions);

    expect(outcome).toMatchObject({
      ok: true,
      plan: { action: "execute", nextAt: NOW + WATCHDOG_MS },
    });
    expect(chromeMock.persistedQueue()).toMatchObject({
      status: "running",
      nextAt: NOW + WATCHDOG_MS,
      ownerUserId: OWNER.userId,
      items: [{ userId: "1", status: "in-flight" }, { userId: "2", status: "pending" }],
    });
    expect(chromeMock.messages).toEqual([
      { tabId: 7, message: { type: "UNFOLLOW_ONE", target: user(), account: OWNER } },
    ]);
    expect(chromeMock.alarms.get(UNFOLLOW_ALARM_NAME)).toBe(NOW + WATCHDOG_MS);
    expect(chromeMock.updates).toEqual([{ tabId: 7, url: "https://x.com/alice", active: true }]);
  });

  it("persists nextAt before the alarm is created", async () => {
    chromeMock.seed(baseState());

    await startUnfollowQueue(["1"], NOW, () => 0, routeOptions);

    const persistIndex = chromeMock.order.findIndex((entry) =>
      entry.startsWith(`persist:status=running,nextAt=${NOW + WATCHDOG_MS}`),
    );
    const alarmIndex = chromeMock.order.findIndex((entry) => entry.startsWith("alarm:"));

    expect(persistIndex).toBeGreaterThanOrEqual(0);
    expect(alarmIndex).toBeGreaterThan(persistIndex);
  });

  it("refuses to start and persists nothing when the request is rejected", async () => {
    chromeMock.seed(baseState({ syncMeta: syncMeta({ status: "running" }) }));

    const outcome = await startUnfollowQueue(["1"], NOW, () => 0);

    expect(outcome).toEqual({ ok: false, reason: "sync-running" });
    expect(chromeMock.storage.local.set).not.toHaveBeenCalled();
    expect(chromeMock.alarmsApi.create).not.toHaveBeenCalled();
  });
});

describe("runQueueTick", () => {
  it("does nothing but keep the alarm armed before the schedule is due", async () => {
    chromeMock.seed(baseState({ unfollowQueue: runningQueue({ nextAt: NOW + 30_000 }) }));

    const plan = await runQueueTick(NOW, () => 0, routeOptions);

    expect(plan).toMatchObject({ action: "wait", nextAt: NOW + 30_000 });
    expect(chromeMock.messages).toEqual([]);
    expect(chromeMock.tabsApi.update).not.toHaveBeenCalled();
    expect(chromeMock.alarms.get(UNFOLLOW_ALARM_NAME)).toBe(NOW + 30_000);
    // Re-arming an unchanged schedule must not rewrite the state tree.
    expect(chromeMock.storage.local.set).not.toHaveBeenCalled();
  });

  it("routes the single X tab and issues exactly one UNFOLLOW_ONE", async () => {
    chromeMock.seed(baseState({ unfollowQueue: runningQueue({ nextAt: NOW }) }));

    const plan = await runQueueTick(NOW, () => 0, routeOptions);

    expect(plan.action).toBe("execute");
    expect(chromeMock.updates).toEqual([{ tabId: 7, url: "https://x.com/alice", active: true }]);
    expect(chromeMock.messages).toEqual([
      {
        tabId: 7,
        message: { type: "UNFOLLOW_ONE", target: user(), account: OWNER },
      },
    ]);
    expect(chromeMock.tabsApi.create).not.toHaveBeenCalled();
  });

  it("marks the flight and persists the watchdog schedule before it sends the command", async () => {
    chromeMock.seed(baseState({ unfollowQueue: runningQueue({ nextAt: NOW }) }));

    await runQueueTick(NOW, () => 0, routeOptions);

    const persistIndex = chromeMock.order.findIndex((entry) =>
      entry.startsWith(`persist:status=running,nextAt=${NOW + WATCHDOG_MS}`),
    );
    const alarmIndex = chromeMock.order.indexOf(
      `alarm:${UNFOLLOW_ALARM_NAME}@${NOW + WATCHDOG_MS}`,
    );
    const sendIndex = chromeMock.order.indexOf("send:UNFOLLOW_ONE");

    expect(persistIndex).toBeGreaterThanOrEqual(0);
    expect(alarmIndex).toBeGreaterThan(persistIndex);
    expect(sendIndex).toBeGreaterThan(alarmIndex);
    expect(chromeMock.persistedQueue().items[0]).toMatchObject({
      status: "in-flight",
      attempts: 1,
    });
  });

  it("pauses with missing-tab when no X context is open", async () => {
    install(createChromeMock([{ id: 7, url: "https://example.com/" }]));
    chromeMock.seed(baseState({ unfollowQueue: runningQueue({ nextAt: NOW }) }));

    const plan = await runQueueTick(NOW, () => 0, routeOptions);

    expect(plan).toMatchObject({ action: "pause", reason: "missing-tab" });
    expect(chromeMock.persistedQueue()).toMatchObject({
      status: "paused",
      pauseReason: "missing-tab",
      items: [
        { userId: "1", status: "pending", attempts: 0 },
        { userId: "2", status: "pending", attempts: 0 },
      ],
    });
    expect(chromeMock.messages).toEqual([]);
    expect(chromeMock.alarms.has(UNFOLLOW_ALARM_NAME)).toBe(false);
  });

  it("rolls the attempt back when the content script cannot be reached", async () => {
    chromeMock.seed(baseState({ unfollowQueue: runningQueue({ nextAt: NOW }) }));
    chromeMock.breakDelivery();

    const plan = await runQueueTick(NOW, () => 0, routeOptions);

    expect(plan).toMatchObject({ action: "pause", reason: "missing-tab" });
    expect(chromeMock.persistedQueue()).toMatchObject({
      status: "paused",
      pauseReason: "missing-tab",
      items: [
        { userId: "1", status: "pending", attempts: 0 },
        { userId: "2", status: "pending", attempts: 0 },
      ],
      nextAt: null,
    });
  });

  it("honours a persisted schedule after a service-worker restart", async () => {
    chromeMock.seed(baseState({ unfollowQueue: runningQueue({ nextAt: NOW + 45_000 }) }));

    const plan = await runQueueTick(NOW, () => 0, routeOptions);

    expect(plan).toMatchObject({ action: "wait", nextAt: NOW + 45_000 });
    expect(chromeMock.messages).toEqual([]);
  });

  it("stops before touching a tab when the account switched", async () => {
    chromeMock.seed({
      ...baseState({ unfollowQueue: runningQueue({ nextAt: NOW }) }),
      session: { account: { userId: "42", handle: "other" }, checkedAt: NOW },
    });

    const plan = await runQueueTick(NOW, () => 0, routeOptions);

    expect(plan).toMatchObject({ action: "pause", reason: "account-mismatch" });
    expect(chromeMock.persistedQueue()).toMatchObject({
      status: "stopped",
      pauseReason: "account-mismatch",
    });
    expect(chromeMock.tabsApi.update).not.toHaveBeenCalled();
    expect(chromeMock.messages).toEqual([]);
    expect(chromeMock.alarms.has(UNFOLLOW_ALARM_NAME)).toBe(false);
  });

  it("skips a target that stopped being a candidate instead of unfollowing it", async () => {
    chromeMock.seed(
      baseState({
        following: { "1": user({ followedBy: true }), "2": user({ userId: "2", handle: "bob" }) },
        unfollowQueue: runningQueue({ nextAt: NOW }),
      }),
    );

    const plan = await runQueueTick(NOW, () => 0, routeOptions);

    expect(plan).toMatchObject({ action: "execute", target: { userId: "2" } });
    expect(chromeMock.updates).toEqual([{ tabId: 7, url: "https://x.com/bob", active: true }]);
    expect(chromeMock.persistedQueue().items[0]).toMatchObject({ status: "skipped" });
  });

  it("completes the session and disarms the alarm when nothing is left", async () => {
    chromeMock.seed(
      baseState({
        unfollowQueue: runningQueue({
          items: [item({ status: "done" }), item({ userId: "2", handle: "bob", status: "failed" })],
          nextAt: NOW,
        }),
      }),
    );

    const plan = await runQueueTick(NOW, () => 0, routeOptions);

    expect(plan).toEqual({ action: "complete", nextAt: null });
    expect(chromeMock.persistedQueue()).toMatchObject({ status: "completed", nextAt: null });
    expect(chromeMock.alarmsApi.clear).toHaveBeenCalledWith(UNFOLLOW_ALARM_NAME);
    expect(isQueueBlockingSync(chromeMock.persistedQueue(), NOW)).toBe(false);
  });

  it("arms the demotion of an expired cooldown without resuming the work", async () => {
    chromeMock.seed(
      baseState({
        unfollowQueue: runningQueue({
          status: "cooldown",
          cooldownUntil: NOW,
          pauseReason: "rate-limited",
          nextAt: NOW,
        }),
      }),
    );

    const plan = await runQueueTick(NOW, () => 0, routeOptions);

    expect(plan).toMatchObject({ action: "pause", reason: "rate-limited" });
    expect(chromeMock.persistedQueue()).toMatchObject({
      status: "paused",
      pauseReason: "rate-limited",
    });
    expect(chromeMock.messages).toEqual([]);
    expect(isQueueBlockingSync(chromeMock.persistedQueue(), NOW)).toBe(false);
  });

  it("keeps the queue asleep during an open cooldown", async () => {
    const cooldownUntil = NOW + COOLDOWN_MS;
    chromeMock.seed(
      baseState({
        unfollowQueue: runningQueue({
          status: "cooldown",
          cooldownUntil,
          pauseReason: "rate-limited",
          nextAt: NOW,
        }),
      }),
    );

    const plan = await runQueueTick(NOW, () => 0, routeOptions);

    expect(plan).toMatchObject({ action: "wait", nextAt: cooldownUntil });
    expect(chromeMock.messages).toEqual([]);
    expect(chromeMock.alarms.get(UNFOLLOW_ALARM_NAME)).toBe(cooldownUntil);
  });

  it("fails a flight whose result never arrived and does not repeat the write", async () => {
    chromeMock.seed(inFlightState({ nextAt: NOW }));

    const plan = await runQueueTick(NOW, () => 0, routeOptions);

    expect(chromeMock.persistedQueue().items[0]).toMatchObject({
      status: "failed",
      lastCode: "verification-failed",
    });
    expect(plan).toMatchObject({
      action: "execute",
      target: item({ userId: "2", handle: "bob" }),
    });
    expect(chromeMock.messages).toEqual([
      {
        tabId: 7,
        message: { type: "UNFOLLOW_ONE", target: user({ userId: "2", handle: "bob" }), account: OWNER },
      },
    ]);
  });
});

describe("applyUnfollowResult", () => {
  it("records the result and immediately starts the next target", async () => {
    chromeMock.seed(inFlightState());

    const plan = await applyUnfollowResult(result(), NOW, () => 0, routeOptions);

    expect(chromeMock.persistedQueue()).toMatchObject({
      items: [
        { userId: "1", status: "done" },
        { userId: "2", status: "in-flight" },
      ],
      actionTimestamps: [NOW],
      nextAt: NOW + WATCHDOG_MS,
    });
    expect(plan).toMatchObject({ action: "execute" });
    expect(chromeMock.messages).toEqual([
      {
        tabId: 7,
        message: { type: "UNFOLLOW_ONE", target: user({ userId: "2", handle: "bob" }), account: OWNER },
      },
    ]);
    expect(chromeMock.alarms.get(UNFOLLOW_ALARM_NAME)).toBe(NOW + WATCHDOG_MS);
  });

  it("audits a breaker result and leaves the queue asleep", async () => {
    chromeMock.seed(inFlightState());

    await applyUnfollowResult(
      result({ ok: false, code: "rate-limited" }),
      NOW,
      () => 0,
      routeOptions,
    );

    expect(chromeMock.persistedQueue()).toMatchObject({
      status: "cooldown",
      cooldownUntil: NOW + COOLDOWN_MS,
      pauseReason: "rate-limited",
    });
    expect(chromeMock.persisted().auditLog).toHaveLength(1);
    expect(chromeMock.alarms.get(UNFOLLOW_ALARM_NAME)).toBe(NOW + COOLDOWN_MS);
  });

  it("stops the queue when the result arrives after an account switch", async () => {
    chromeMock.seed({
      ...inFlightState(),
      session: { account: { userId: "42", handle: "other" }, checkedAt: NOW },
    });

    await applyUnfollowResult(result(), NOW, () => 0, routeOptions);

    const persisted = chromeMock.persisted();
    expect(persisted.unfollowQueue).toMatchObject({
      status: "stopped",
      pauseReason: "account-mismatch",
    });
    expect(persisted.auditLog).toHaveLength(1);
    expect(chromeMock.alarms.has(UNFOLLOW_ALARM_NAME)).toBe(false);
  });
});

describe("a full session", () => {
  it("walks two targets one at a time, dwelling on each profile before the click", async () => {
    chromeMock.seed(baseState());

    await startUnfollowQueue(["1", "2"], NOW, () => 0, routeOptions);
    expect(chromeMock.messages.map((entry) => entry.message)).toEqual([
      { type: "UNFOLLOW_ONE", target: user(), account: OWNER },
    ]);
    expect(chromeMock.persistedQueue().items[0]).toMatchObject({ status: "in-flight" });

    // A second tick while the first command is outstanding must stay silent.
    await runQueueTick(NOW + 1_000, () => 0, routeOptions);
    expect(chromeMock.messages).toHaveLength(1);

    const firstDoneAt = NOW + 2_000;
    await applyUnfollowResult(result(), firstDoneAt, () => 0, routeOptions);
    expect(chromeMock.messages.map((entry) => entry.message)).toEqual([
      { type: "UNFOLLOW_ONE", target: user(), account: OWNER },
      { type: "UNFOLLOW_ONE", target: user({ userId: "2", handle: "bob" }), account: OWNER },
    ]);
    expect(chromeMock.persistedQueue().nextAt).toBe(firstDoneAt + WATCHDOG_MS);

    const secondDoneAt = firstDoneAt + 1_000;
    await applyUnfollowResult(
      result({ userId: "2", handle: "bob" }),
      secondDoneAt,
      () => 0,
      routeOptions,
    );

    const finished = await runQueueTick(secondDoneAt + 1_000, () => 0, routeOptions);
    expect(finished).toEqual({ action: "complete", nextAt: null });
    expect(chromeMock.persistedQueue()).toMatchObject({ status: "completed", nextAt: null });
    expect(chromeMock.persisted().auditLog).toHaveLength(2);
    expect(chromeMock.persistedQueue().actionTimestamps).toEqual([firstDoneAt, secondDoneAt]);
  });
});

describe("pauseUnfollowQueue and stopUnfollowQueue", () => {
  it("clears the alarm when the user pauses", async () => {
    chromeMock.seed(baseState({ unfollowQueue: runningQueue({ nextAt: NOW + 30_000 }) }));

    await pauseUnfollowQueue("user");

    expect(chromeMock.persistedQueue()).toMatchObject({ status: "paused", pauseReason: "user" });
    expect(chromeMock.alarmsApi.clear).toHaveBeenCalledWith(UNFOLLOW_ALARM_NAME);
    expect(chromeMock.alarms.has(UNFOLLOW_ALARM_NAME)).toBe(false);
  });

  it("clears the alarm when the user stops", async () => {
    chromeMock.seed(baseState({ unfollowQueue: runningQueue({ nextAt: NOW + 30_000 }) }));

    await stopUnfollowQueue();

    expect(chromeMock.persistedQueue()).toMatchObject({ status: "stopped", pauseReason: null });
    expect(chromeMock.alarms.has(UNFOLLOW_ALARM_NAME)).toBe(false);
  });

  it("does not resurrect the queue when there is nothing to pause", async () => {
    chromeMock.seed(baseState());

    await pauseUnfollowQueue("user");

    expect(chromeMock.storage.local.set).not.toHaveBeenCalled();
  });
});
