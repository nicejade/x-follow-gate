import { FOLLOWING_PAGE_DATA, MESSAGE_SOURCE } from "@/content/bridge-protocol";
import {
  AUTH_SETTLE_DELAYS_MS,
  createAuthProbe,
  createRuntimeMessageHandler,
  installFollowingBridge,
  runUnfollowCommand,
  validateFollowingUsers,
} from "@/content/isolated";
import type { ScrollController } from "@/content/scroll-controller";
import { DEFAULT_FOLLOWING_BATCH_LIMITS } from "@/shared/following-batch";
import type { ExtensionMessage } from "@/shared/messages";
import type { AccountIdentity, FollowingUser, UnfollowResult } from "@/shared/types";

vi.mock("@/content/unfollow-driver", () => ({
  createBrowserUnfollowEnvironment: vi.fn(() => ({})),
  unfollowOne: vi.fn(),
}));

import { unfollowOne } from "@/content/unfollow-driver";

const ORIGIN = "https://x.com";
const PAGE_TIME = 1_600_000_000_000;
const ISOLATED_TIME = 1_700_000_000_000;

function pageUser(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    userId: "1",
    handle: "alice",
    name: "Alice",
    avatarUrl: null,
    followedBy: false,
    syncedAt: PAGE_TIME,
    ...overrides,
  };
}

function createFakeTarget(origin = ORIGIN) {
  const listeners: Array<(event: MessageEvent) => void> = [];

  const target = {
    addEventListener(_type: "message", listener: (event: MessageEvent) => void): void {
      listeners.push(listener);
    },
    removeEventListener(_type: "message", listener: (event: MessageEvent) => void): void {
      const index = listeners.indexOf(listener);
      if (index >= 0) {
        listeners.splice(index, 1);
      }
    },
    location: { origin },
  };

  return {
    target,
    get listenerCount() {
      return listeners.length;
    },
    dispatch(event: { source?: unknown; origin?: string; data?: unknown }): void {
      const payload = {
        source: target,
        origin,
        ...event,
      } as unknown as MessageEvent;

      for (const listener of [...listeners]) {
        listener(payload);
      }
    },
  };
}

function pageMessage(users: unknown): Record<string, unknown> {
  return { source: MESSAGE_SOURCE, type: FOLLOWING_PAGE_DATA, users };
}

function createHarness(origin = ORIGIN) {
  const fake = createFakeTarget(origin);
  const sent: ExtensionMessage[] = [];
  const observed: FollowingUser[][] = [];

  const uninstall = installFollowingBridge({
    target: fake.target,
    sendMessage: (message) => {
      sent.push(message);
    },
    now: () => ISOLATED_TIME,
    onUsers: (users) => observed.push(users),
  });

  return { fake, sent, observed, uninstall };
}

describe("installFollowingBridge", () => {
  it("forwards a validated batch as FOLLOWING_BATCH stamped with the isolated clock", () => {
    const { fake, sent } = createHarness();

    fake.dispatch({ data: pageMessage([pageUser({ handle: "@Alice" })]) });

    expect(sent).toEqual([
      {
        type: "FOLLOWING_BATCH",
        users: [
          {
            userId: "1",
            handle: "alice",
            name: "Alice",
            avatarUrl: null,
            followedBy: false,
            isBlueVerified: null,
            protected: null,
            statusesCount: null,
            friendsCount: null,
            followersCount: null,
            syncedAt: ISOLATED_TIME,
          },
        ],
      },
    ]);
  });

  it("ignores a message posted by another window", () => {
    const { fake, sent } = createHarness();

    fake.dispatch({ source: { other: "frame" }, data: pageMessage([pageUser()]) });

    expect(sent).toEqual([]);
  });

  it("ignores a message from a foreign origin", () => {
    const { fake, sent } = createHarness();

    fake.dispatch({ origin: "https://evil.example", data: pageMessage([pageUser()]) });

    expect(sent).toEqual([]);
  });

  it("ignores messages that do not carry the bridge source and type", () => {
    const { fake, sent } = createHarness();

    fake.dispatch({ data: { ...pageMessage([pageUser()]), source: "somebody-else" } });
    fake.dispatch({ data: { ...pageMessage([pageUser()]), type: "SOMETHING_ELSE" } });
    fake.dispatch({ data: null });
    fake.dispatch({ data: "FOLLOWING_PAGE_DATA" });
    fake.dispatch({ data: [pageUser()] });

    expect(sent).toEqual([]);
  });

  it("rejects an oversized batch outright", () => {
    const { fake, sent } = createHarness();
    const users = Array.from({ length: DEFAULT_FOLLOWING_BATCH_LIMITS.maxUsers + 1 }, (_, i) =>
      pageUser({ userId: `${i}`, handle: `user${i}` }),
    );

    fake.dispatch({ data: pageMessage(users) });

    expect(sent).toEqual([]);
  });

  it("stays silent when no record survives validation", () => {
    const { fake, sent, observed } = createHarness();

    fake.dispatch({ data: pageMessage([pageUser({ userId: "" }), { junk: true }]) });

    expect(sent).toEqual([]);
    expect(observed).toEqual([]);
  });

  it("reports the surviving users so the scroll round can measure growth", () => {
    const { fake, observed } = createHarness();

    fake.dispatch({ data: pageMessage([pageUser(), pageUser({ userId: "2", handle: "bob" })]) });

    expect(observed).toHaveLength(1);
    expect(observed[0]?.map((user) => user.userId)).toEqual(["1", "2"]);
  });

  it("stops forwarding once uninstalled", () => {
    const { fake, sent, uninstall } = createHarness();

    uninstall();
    fake.dispatch({ data: pageMessage([pageUser()]) });

    expect(fake.listenerCount).toBe(0);
    expect(sent).toEqual([]);
  });

  it("never lets a messaging failure escape into the page", () => {
    const fake = createFakeTarget();
    installFollowingBridge({
      target: fake.target,
      sendMessage: () => {
        throw new Error("extension context invalidated");
      },
      now: () => ISOLATED_TIME,
    });

    expect(() => fake.dispatch({ data: pageMessage([pageUser()]) })).not.toThrow();
  });

  it("exposes the same validator the bridge applies", () => {
    expect(validateFollowingUsers([pageUser()], ISOLATED_TIME)).toEqual([
      {
        userId: "1",
        handle: "alice",
        name: "Alice",
        avatarUrl: null,
        followedBy: false,
        isBlueVerified: null,
        protected: null,
        statusesCount: null,
        friendsCount: null,
        followersCount: null,
        syncedAt: ISOLATED_TIME,
      },
    ]);
  });
});

const ACCOUNT: AccountIdentity = { userId: "9", handle: "self" };

function followingUser(overrides: Partial<FollowingUser> = {}): FollowingUser {
  return {
    userId: "1",
    handle: "alice",
    name: "Alice",
    avatarUrl: null,
    followedBy: false,
    isBlueVerified: null,
    protected: null,
    statusesCount: null,
    friendsCount: null,
    followersCount: null,
    syncedAt: 1,
    ...overrides,
  };
}

/**
 * Deterministic scheduler for the auth probe. It holds a single pending timer and
 * throws if a second one is armed, which is how the tests enforce a finite
 * settle ladder instead of a standing poll.
 */
function createFakeScheduler() {
  let nextTimerId = 1;
  let pending: { id: number; callback: () => void } | null = null;
  const delays: number[] = [];
  const cancelled: number[] = [];

  return {
    schedule(callback: () => void, delayMs: number): number {
      if (pending !== null) {
        throw new Error("a second auth timer was armed while one was still pending");
      }

      const id = nextTimerId;
      nextTimerId += 1;
      pending = { id, callback };
      delays.push(delayMs);

      return id;
    },
    cancel(timerId: number): void {
      cancelled.push(timerId);
      if (pending?.id === timerId) {
        pending = null;
      }
    },
    delays,
    cancelled,
    get armed(): boolean {
      return pending !== null;
    },
    run(): void {
      const current = pending;
      if (current === null) {
        throw new Error("no pending auth timer to run");
      }

      pending = null;
      current.callback();
    },
    /** Runs the whole pending ladder, with a hard bound on iterations. */
    drain(maxRuns = 20): void {
      for (let index = 0; index < maxRuns && pending !== null; index += 1) {
        this.run();
      }
    },
  };
}

function createProbeHarness(readings: Array<AccountIdentity | null>) {
  const scheduler = createFakeScheduler();
  const reported: Array<AccountIdentity | null> = [];
  const queue = [...readings];
  let detections = 0;

  const probe = createAuthProbe({
    env: {
      detect: () => {
        detections += 1;

        return queue.length > 0 ? (queue.shift() ?? null) : null;
      },
      schedule: (callback, delayMs) => scheduler.schedule(callback, delayMs),
      cancel: (timerId) => {
        scheduler.cancel(timerId);
      },
    },
    report: (account) => reported.push(account),
  });

  return {
    probe,
    scheduler,
    reported,
    get detections() {
      return detections;
    },
  };
}

describe("createAuthProbe", () => {
  it("reports a detected account immediately", () => {
    const harness = createProbeHarness([ACCOUNT]);

    harness.probe.probe();

    expect(harness.reported).toEqual([ACCOUNT]);
    expect(harness.scheduler.armed).toBe(false);
  });

  it("lets the page settle before it trusts an unknown account", () => {
    const harness = createProbeHarness([null, null, ACCOUNT]);

    harness.probe.probe();
    expect(harness.reported).toEqual([]);

    harness.scheduler.drain();

    expect(harness.reported).toEqual([ACCOUNT]);
    expect(harness.scheduler.armed).toBe(false);
  });

  it("reports an unknown account only after the settle ladder is exhausted", () => {
    const harness = createProbeHarness([]);

    harness.probe.probe();
    harness.scheduler.drain();

    expect(harness.reported).toEqual([null]);
    expect(harness.detections).toBe(AUTH_SETTLE_DELAYS_MS.length + 1);
    expect(harness.scheduler.armed).toBe(false);
  });

  it("backs off with growing delays instead of polling at a fixed interval", () => {
    const harness = createProbeHarness([]);

    harness.probe.probe();
    harness.scheduler.drain();

    expect(harness.scheduler.delays).toEqual([...AUTH_SETTLE_DELAYS_MS]);

    const growing = AUTH_SETTLE_DELAYS_MS.every(
      (delay, index) => index === 0 || delay > (AUTH_SETTLE_DELAYS_MS[index - 1] ?? 0),
    );
    expect(growing).toBe(true);
  });

  it("cancels a pending settle ladder", () => {
    const harness = createProbeHarness([]);
    harness.probe.probe();
    expect(harness.scheduler.armed).toBe(true);

    harness.probe.cancel();

    expect(harness.scheduler.armed).toBe(false);
    expect(harness.scheduler.cancelled).toHaveLength(1);
    expect(harness.reported).toEqual([]);
  });

  it("restarts the ladder when a fresh probe begins", () => {
    const harness = createProbeHarness([null, ACCOUNT]);
    harness.probe.probe();

    harness.probe.probe();

    expect(harness.reported).toEqual([ACCOUNT]);
    expect(harness.scheduler.cancelled).toHaveLength(1);
    expect(harness.scheduler.armed).toBe(false);
  });

  it("starts a full ladder again after an unknown account was reported", () => {
    const harness = createProbeHarness([]);
    harness.probe.probe();
    harness.scheduler.drain();

    harness.probe.probe();
    harness.scheduler.drain();

    expect(harness.reported).toEqual([null, null]);
    expect(harness.scheduler.delays).toEqual([...AUTH_SETTLE_DELAYS_MS, ...AUTH_SETTLE_DELAYS_MS]);
  });

  it("reports the first reading verbatim when no settle ladder is configured", () => {
    const scheduler = createFakeScheduler();
    const reported: Array<AccountIdentity | null> = [];
    const probe = createAuthProbe({
      env: {
        detect: () => null,
        schedule: (callback, delayMs) => scheduler.schedule(callback, delayMs),
        cancel: (timerId) => {
          scheduler.cancel(timerId);
        },
      },
      report: (account) => reported.push(account),
      settleDelaysMs: [],
    });

    probe.probe();

    expect(reported).toEqual([null]);
    expect(scheduler.armed).toBe(false);
  });
});

describe("runUnfollowCommand", () => {
  it("waits on the profile before clicking unfollow", async () => {
    vi.useFakeTimers();
    const report = vi.fn();
    const result: UnfollowResult = {
      userId: "1",
      handle: "alice",
      ok: true,
      code: "success",
    };
    vi.mocked(unfollowOne).mockResolvedValue(result);

    const message = {
      type: "UNFOLLOW_ONE" as const,
      target: followingUser(),
      account: { userId: "9", handle: "self" },
      intervalMinSec: 3,
      intervalMaxSec: 12,
    };

    const promise = runUnfollowCommand(message, report, () => 0);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(unfollowOne).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await promise;

    expect(unfollowOne).toHaveBeenCalledTimes(1);
    expect(unfollowOne).toHaveBeenCalledWith(
      message.target,
      expect.anything(),
      message.account,
      {
        interval: { minSec: 3, maxSec: 12 },
        random: expect.any(Function),
      },
    );
    expect(report).toHaveBeenCalledWith(result);
    vi.useRealTimers();
  });
});

describe("createRuntimeMessageHandler", () => {
  it("forwards syncTargetCount to the scroll controller on SCROLL_SESSION_START", () => {
    const start = vi.fn();
    const controller = { start } as Pick<ScrollController, "start"> as ScrollController;
    const authProbe = createAuthProbe({
      env: {
        detect: () => ACCOUNT,
        schedule: () => 1,
        cancel: () => {},
      },
      report: () => {},
      settleDelaysMs: [],
    });
    const listener = createRuntimeMessageHandler({
      authProbe,
      ensureController: () => controller,
      getController: () => controller,
    });

    listener({ type: "SCROLL_SESSION_START", syncTargetCount: 1_500 });

    expect(start).toHaveBeenCalledWith(1_500);
  });

  it("probes auth immediately on AUTH_PROBE", () => {
    const report = vi.fn();
    const authProbe = createAuthProbe({
      env: {
        detect: () => ACCOUNT,
        schedule: () => 1,
        cancel: () => {},
      },
      report,
      settleDelaysMs: [],
    });
    const listener = createRuntimeMessageHandler({
      authProbe,
      ensureController: () => ({ start: vi.fn() }) as unknown as ScrollController,
      getController: () => null,
    });

    listener({ type: "AUTH_PROBE" });

    expect(report).toHaveBeenCalledWith(ACCOUNT);
  });

  it("acknowledges UNFOLLOW_ONE so the worker knows this document accepted it", () => {
    const onUnfollowOne = vi.fn();
    const authProbe = createAuthProbe({
      env: {
        detect: () => ACCOUNT,
        schedule: () => 1,
        cancel: () => {},
      },
      report: () => {},
      settleDelaysMs: [],
    });
    const listener = createRuntimeMessageHandler({
      authProbe,
      ensureController: () => ({ start: vi.fn() }) as unknown as ScrollController,
      getController: () => null,
      onUnfollowOne,
    });
    const message = {
      type: "UNFOLLOW_ONE" as const,
      target: followingUser(),
      account: ACCOUNT,
      intervalMinSec: 3,
      intervalMaxSec: 12,
    };

    expect(listener(message)).toEqual({ accepted: true });
    expect(onUnfollowOne).toHaveBeenCalledWith(message);
  });
});
