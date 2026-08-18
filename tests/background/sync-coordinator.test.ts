import {
  applyAuthStatus,
  applyScrollStatus,
  ingestFollowingBatch,
  pauseSync,
  refreshAuth,
  startSync,
  stopSync,
} from "@/background/sync-coordinator";
import { createDefaultState, STATE_STORAGE_KEY } from "@/shared/defaults";
import type { ExtensionMessage } from "@/shared/messages";
import type { ExtensionState, FollowingUser, ScrollStatus, UnfollowQueue } from "@/shared/types";

const NOW = 1_700_000_000_000;
const ACCOUNT = { userId: "9", handle: "self" };
const FOLLOWING_URL = "https://x.com/self/following";

function signedInState(overrides: Partial<ExtensionState> = {}): ExtensionState {
  return {
    ...createDefaultState(),
    session: { account: ACCOUNT, checkedAt: NOW - 1_000 },
    ...overrides,
  };
}

function queue(overrides: Partial<UnfollowQueue> = {}): UnfollowQueue {
  return { ...createDefaultState().unfollowQueue, ...overrides };
}

function contentUser(overrides: Partial<FollowingUser> = {}): FollowingUser {
  return {
    userId: "1",
    handle: "alice",
    name: "Alice",
    avatarUrl: null,
    followedBy: false,
    syncedAt: 1,
    ...overrides,
  };
}

function scrollStatus(overrides: Partial<ScrollStatus> = {}): ScrollStatus {
  return {
    status: "running",
    stepCount: 4,
    discoveredCount: 12,
    noGrowthSteps: 1,
    likelyComplete: false,
    pauseReason: null,
    ...overrides,
  };
}

function createStorageMock() {
  const records = new Map<string, unknown>();

  const local = {
    get: vi.fn((key: string) => {
      const value = records.get(key);
      return Promise.resolve(value === undefined ? {} : { [key]: structuredClone(value) });
    }),
    set: vi.fn(async (items: Record<string, unknown>) => {
      await Promise.resolve();
      for (const [key, value] of Object.entries(items)) {
        records.set(key, structuredClone(value));
      }
    }),
  };

  return {
    local,
    seed(value: unknown) {
      records.set(STATE_STORAGE_KEY, structuredClone(value));
    },
    persisted(): ExtensionState {
      const value = records.get(STATE_STORAGE_KEY);
      if (value === undefined) {
        throw new Error("nothing was persisted");
      }

      return value as ExtensionState;
    },
  };
}

interface FakeTab {
  id: number;
  url: string;
  active: boolean;
}

function createTabsMock(initial: Array<Partial<FakeTab>> = []) {
  let nextId = 100;
  const tabs: FakeTab[] = initial.map((tab) => ({
    id: tab.id ?? nextId++,
    url: tab.url ?? "https://x.com/home",
    active: tab.active ?? false,
  }));
  const messages: Array<{ tabId: number; message: ExtensionMessage }> = [];
  const created: Array<{ url: string; active: boolean }> = [];
  const updates: Array<{ tabId: number; url?: string; active?: boolean }> = [];
  let deliverable = true;

  const api = {
    query: vi.fn(async () => tabs.map((tab) => ({ ...tab }))),
    create: vi.fn(async (properties: { url?: string; active?: boolean }) => {
      const tab: FakeTab = {
        id: nextId++,
        url: properties.url ?? "",
        active: properties.active ?? true,
      };
      tabs.push(tab);
      created.push({ url: tab.url, active: tab.active });

      return { ...tab };
    }),
    update: vi.fn(async (tabId: number, properties: { url?: string; active?: boolean }) => {
      updates.push({ tabId, ...properties });
      const tab = tabs.find((candidate) => candidate.id === tabId);
      if (tab === undefined) {
        throw new Error(`no tab ${tabId}`);
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
      if (!deliverable) {
        throw new Error("Could not establish connection. Receiving end does not exist.");
      }

      messages.push({ tabId, message });
    }),
  };

  return {
    api,
    messages,
    created,
    updates,
    breakDelivery() {
      deliverable = false;
    },
    types(): Array<ExtensionMessage["type"]> {
      return messages.map((entry) => entry.message.type);
    },
  };
}

let storage: ReturnType<typeof createStorageMock>;
let tabs: ReturnType<typeof createTabsMock>;

function install(tabsMock = createTabsMock([{ id: 7, url: FOLLOWING_URL }])) {
  storage = createStorageMock();
  tabs = tabsMock;
  vi.stubGlobal("chrome", { storage: { local: storage.local }, tabs: tabs.api });
}

beforeEach(() => {
  install();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("startSync", () => {
  it("refuses to start while the unfollow queue is running", async () => {
    storage.seed(signedInState({ unfollowQueue: queue({ status: "running" }) }));

    const result = await startSync(NOW);

    expect(result).toMatchObject({ ok: false, reason: "queue-running" });
    expect(tabs.messages).toEqual([]);
    expect(storage.persisted().syncMeta).toMatchObject({
      status: "paused",
      pauseReason: "queue-running",
    });
  });

  it("refuses to start while the queue is cooling down", async () => {
    storage.seed(
      signedInState({
        unfollowQueue: queue({ status: "paused", cooldownUntil: NOW + 60_000 }),
      }),
    );

    const result = await startSync(NOW);

    expect(result).toMatchObject({ ok: false, reason: "queue-running" });
    expect(tabs.api.sendMessage).not.toHaveBeenCalled();
  });

  it("refuses to start while an unfollow is in flight", async () => {
    storage.seed(
      signedInState({
        unfollowQueue: queue({
          status: "idle",
          items: [
            { userId: "1", handle: "alice", status: "in-flight", attempts: 1, lastCode: null },
          ],
        }),
      }),
    );

    const result = await startSync(NOW);

    expect(result).toMatchObject({ ok: false, reason: "queue-running" });
  });

  it("refuses to start without a confirmed signed-in account", async () => {
    storage.seed(createDefaultState());

    const result = await startSync(NOW);

    expect(result).toMatchObject({ ok: false, reason: "auth" });
    expect(storage.persisted().syncMeta).toMatchObject({ status: "paused", pauseReason: "auth" });
    expect(tabs.api.create).not.toHaveBeenCalled();
  });

  it("reuses an open Following tab and brings it to the front", async () => {
    storage.seed(
      signedInState({
        settings: { ...createDefaultState().settings, syncTargetCount: 2_000 },
      }),
    );

    const result = await startSync(NOW);

    expect(result).toMatchObject({ ok: true, tabId: 7 });
    expect(tabs.api.create).not.toHaveBeenCalled();
    expect(tabs.updates).toEqual([{ tabId: 7, active: true }]);
    expect(tabs.messages).toContainEqual({
      tabId: 7,
      message: { type: "SCROLL_SESSION_START", syncTargetCount: 2_000 },
    });
  });

  it("recognizes the Following tab across hosts, casing and a trailing slash", async () => {
    for (const url of [
      "https://twitter.com/self/following",
      "https://x.com/Self/Following/",
      "https://x.com/self/following?foo=bar",
    ]) {
      install(createTabsMock([{ id: 11, url }]));
      storage.seed(signedInState());

      const result = await startSync(NOW);

      expect(result, url).toMatchObject({ ok: true, tabId: 11 });
      expect(tabs.api.create, url).not.toHaveBeenCalled();
    }
  });

  it("navigates an existing X tab when no Following tab is open", async () => {
    install(createTabsMock([{ id: 5, url: "https://x.com/home" }]));
    storage.seed(signedInState());

    const result = await startSync(NOW);

    expect(result).toMatchObject({ ok: true, tabId: 5 });
    expect(tabs.api.create).not.toHaveBeenCalled();
    expect(tabs.updates).toEqual([{ tabId: 5, url: FOLLOWING_URL, active: true }]);
  });

  it("opens one visible tab when no X tab exists", async () => {
    install(createTabsMock([]));
    storage.seed(signedInState());

    const result = await startSync(NOW);

    expect(result.ok).toBe(true);
    expect(tabs.created).toEqual([{ url: FOLLOWING_URL, active: true }]);
    expect(tabs.api.create).toHaveBeenCalledTimes(1);
  });

  it("ignores tabs that are not on an X host", async () => {
    install(createTabsMock([{ id: 3, url: "https://evil.example/self/following" }]));
    storage.seed(signedInState());

    await startSync(NOW);

    expect(tabs.created).toEqual([{ url: FOLLOWING_URL, active: true }]);
    expect(tabs.updates).toEqual([]);
  });

  it("persists a fresh running round before the tab is told to scroll", async () => {
    storage.seed(
      signedInState({
        following: {
          "1": contentUser(),
          "2": contentUser({ userId: "2", handle: "bob" }),
        },
        syncMeta: {
          status: "completed",
          startedAt: NOW - 900_000,
          updatedAt: NOW - 800_000,
          stepCount: 50,
          discoveredCount: 2,
          noGrowthSteps: 5,
          likelyComplete: true,
          pauseReason: "stalled",
        },
      }),
    );

    await startSync(NOW);

    expect(storage.persisted().syncMeta).toEqual({
      status: "running",
      startedAt: NOW,
      updatedAt: NOW,
      stepCount: 0,
      discoveredCount: 2,
      noGrowthSteps: 0,
      likelyComplete: false,
      pauseReason: null,
    });
  });

  it("reports missing-tab when the Following tab disappears before it is focused", async () => {
    storage.seed(signedInState());
    tabs.api.update.mockRejectedValueOnce(new Error("No tab with id: 7."));

    const result = await startSync(NOW);

    expect(result).toMatchObject({ ok: false, reason: "missing-tab" });
    expect(storage.persisted().syncMeta).toMatchObject({
      status: "paused",
      pauseReason: "missing-tab",
    });
    expect(tabs.api.sendMessage).not.toHaveBeenCalled();
  });

  it("keeps the round running when the content script is not ready yet", async () => {
    storage.seed(signedInState());
    tabs.breakDelivery();

    const result = await startSync(NOW);

    expect(result).toMatchObject({ ok: true, delivered: false });
    expect(storage.persisted().syncMeta.status).toBe("running");
  });
});

describe("pauseSync", () => {
  it("persists the reason and tells the tab to pause", async () => {
    storage.seed(
      signedInState({
        syncMeta: { ...createDefaultState().syncMeta, status: "running", startedAt: NOW - 1_000 },
      }),
    );

    await pauseSync("user", NOW);

    expect(storage.persisted().syncMeta).toMatchObject({
      status: "paused",
      pauseReason: "user",
      updatedAt: NOW,
    });
    expect(tabs.messages).toEqual([
      { tabId: 7, message: { type: "SCROLL_SESSION_PAUSE", reason: "user" } },
    ]);
  });

  it("ignores a pause when no round is active", async () => {
    storage.seed(signedInState());

    await pauseSync("user", NOW);

    expect(storage.persisted().syncMeta.status).toBe("idle");
    expect(tabs.api.sendMessage).not.toHaveBeenCalled();
  });

  it("reports an undelivered pause command instead of failing silently", async () => {
    storage.seed(
      signedInState({
        syncMeta: { ...createDefaultState().syncMeta, status: "running", startedAt: NOW - 1_000 },
      }),
    );
    tabs.breakDelivery();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await pauseSync("user", NOW);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("SCROLL_SESSION_PAUSE");
    expect(storage.persisted().syncMeta).toMatchObject({ status: "paused", pauseReason: "user" });
    warn.mockRestore();
  });

  it("replaces an automatic pause reason when the user pauses the round", async () => {
    storage.seed(
      signedInState({
        syncMeta: {
          ...createDefaultState().syncMeta,
          status: "paused",
          pauseReason: "hidden",
          startedAt: NOW - 10_000,
        },
      }),
    );

    await pauseSync("user", NOW);

    expect(storage.persisted().syncMeta).toMatchObject({
      status: "paused",
      pauseReason: "user",
      updatedAt: NOW,
    });
    expect(tabs.messages).toEqual([
      { tabId: 7, message: { type: "SCROLL_SESSION_PAUSE", reason: "user" } },
    ]);
  });

  it("keeps a user pause when an automatic reason arrives afterwards", async () => {
    storage.seed(
      signedInState({
        syncMeta: {
          ...createDefaultState().syncMeta,
          status: "paused",
          pauseReason: "user",
          startedAt: NOW - 10_000,
        },
      }),
    );

    await pauseSync("hidden", NOW);

    expect(storage.persisted().syncMeta.pauseReason).toBe("user");
    expect(tabs.api.sendMessage).not.toHaveBeenCalled();
  });

  it("ignores a pause that repeats the reason already recorded", async () => {
    storage.seed(
      signedInState({
        syncMeta: { ...createDefaultState().syncMeta, status: "paused", pauseReason: "hidden" },
      }),
    );

    await pauseSync("hidden", NOW);

    expect(storage.local.set).not.toHaveBeenCalled();
    expect(tabs.api.sendMessage).not.toHaveBeenCalled();
  });
});

describe("stopSync", () => {
  it("persists the stop and tells the tab to end the round", async () => {
    storage.seed(
      signedInState({
        syncMeta: {
          ...createDefaultState().syncMeta,
          status: "paused",
          pauseReason: "hidden",
          stepCount: 12,
        },
      }),
    );

    await stopSync(NOW);

    expect(storage.persisted().syncMeta).toMatchObject({
      status: "stopped",
      pauseReason: null,
      stepCount: 12,
      updatedAt: NOW,
    });
    expect(tabs.messages).toEqual([{ tabId: 7, message: { type: "SCROLL_SESSION_STOP" } }]);
  });

  it("does not fail when the Following tab is already gone", async () => {
    install(createTabsMock([]));
    storage.seed(
      signedInState({
        syncMeta: { ...createDefaultState().syncMeta, status: "running" },
      }),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(stopSync(NOW)).resolves.toBeUndefined();

    expect(storage.persisted().syncMeta.status).toBe("stopped");
    expect(String(warn.mock.calls[0]?.[0])).toContain("SCROLL_SESSION_STOP");
    warn.mockRestore();
  });
});

describe("ingestFollowingBatch", () => {
  it("merges reported users and recomputes candidates", async () => {
    storage.seed(signedInState({ whitelist: [{ handle: "bob" }] }));

    await ingestFollowingBatch(
      [
        contentUser(),
        contentUser({ userId: "2", handle: "bob" }),
        contentUser({ userId: "3", handle: "carol", followedBy: true }),
      ],
      NOW,
    );

    const state = storage.persisted();
    expect(Object.keys(state.following)).toEqual(["1", "2", "3"]);
    expect(state.candidates).toEqual(["1"]);
  });

  it("stamps the worker clock over any timestamp the content script reported", async () => {
    storage.seed(signedInState());

    await ingestFollowingBatch([contentUser({ syncedAt: NOW + 10 * 60_000 })], NOW);

    expect(storage.persisted().following["1"]?.syncedAt).toBe(NOW);
  });

  it("keeps a stored observation that is newer than the incoming batch", async () => {
    storage.seed(
      signedInState({
        following: { "1": contentUser({ followedBy: true, syncedAt: NOW + 1_000 }) },
      }),
    );

    await ingestFollowingBatch([contentUser({ followedBy: false })], NOW);

    expect(storage.persisted().following["1"]).toMatchObject({
      followedBy: true,
      syncedAt: NOW + 1_000,
    });
  });

  it("updates round progress while the round is running", async () => {
    storage.seed(
      signedInState({
        syncMeta: {
          ...createDefaultState().syncMeta,
          status: "running",
          startedAt: NOW - 5_000,
          discoveredCount: 0,
        },
      }),
    );

    await ingestFollowingBatch([contentUser(), contentUser({ userId: "2", handle: "bob" })], NOW);

    expect(storage.persisted().syncMeta).toMatchObject({
      status: "running",
      discoveredCount: 2,
      updatedAt: NOW,
    });
  });

  it("stores data without touching round progress when no round is running", async () => {
    storage.seed(signedInState());

    await ingestFollowingBatch([contentUser()], NOW);

    const state = storage.persisted();
    expect(Object.keys(state.following)).toEqual(["1"]);
    expect(state.syncMeta).toEqual(createDefaultState().syncMeta);
  });

  it("ignores malformed and oversized payloads", async () => {
    storage.seed(signedInState());

    await ingestFollowingBatch("not-a-batch", NOW);
    await ingestFollowingBatch([{ userId: "", handle: "" }], NOW);
    await ingestFollowingBatch(
      Array.from({ length: 5_000 }, (_, index) => contentUser({ userId: `${index}` })),
      NOW,
    );

    expect(storage.local.set).not.toHaveBeenCalled();
  });
});

describe("applyScrollStatus", () => {
  it("persists reported progress with the worker clock", async () => {
    storage.seed(
      signedInState({
        syncMeta: { ...createDefaultState().syncMeta, status: "running", startedAt: NOW - 4_000 },
      }),
    );

    await applyScrollStatus(scrollStatus({ status: "paused", pauseReason: "hidden" }), NOW);

    expect(storage.persisted().syncMeta).toEqual({
      status: "paused",
      startedAt: NOW - 4_000,
      updatedAt: NOW,
      stepCount: 4,
      discoveredCount: 12,
      noGrowthSteps: 1,
      likelyComplete: false,
      pauseReason: "hidden",
    });
  });

  it("never lets the reported count regress below what is stored", async () => {
    storage.seed(
      signedInState({
        following: {
          "1": contentUser(),
          "2": contentUser({ userId: "2", handle: "bob" }),
          "3": contentUser({ userId: "3", handle: "carol" }),
        },
        syncMeta: { ...createDefaultState().syncMeta, status: "running", discoveredCount: 3 },
      }),
    );

    await applyScrollStatus(scrollStatus({ discoveredCount: 1 }), NOW);

    expect(storage.persisted().syncMeta.discoveredCount).toBe(3);
  });

  it("sanitizes values a compromised content script could report", async () => {
    storage.seed(
      signedInState({
        syncMeta: { ...createDefaultState().syncMeta, status: "running", startedAt: NOW - 1 },
      }),
    );

    await applyScrollStatus(
      {
        status: "exploded",
        stepCount: -5,
        discoveredCount: Number.NaN,
        noGrowthSteps: 2.7,
        likelyComplete: "yes",
        pauseReason: "whatever",
      } as unknown as ScrollStatus,
      NOW,
    );

    expect(storage.persisted().syncMeta).toMatchObject({
      status: "running",
      stepCount: 0,
      discoveredCount: 0,
      noGrowthSteps: 2,
      likelyComplete: false,
      pauseReason: null,
    });
  });

  it("ignores a stale report that would revive a round the user stopped", async () => {
    storage.seed(
      signedInState({
        syncMeta: {
          ...createDefaultState().syncMeta,
          status: "stopped",
          startedAt: NOW - 20_000,
          updatedAt: NOW - 500,
          stepCount: 9,
        },
      }),
    );

    await applyScrollStatus(scrollStatus(), NOW);

    expect(storage.persisted().syncMeta).toMatchObject({
      status: "stopped",
      stepCount: 9,
      updatedAt: NOW - 500,
    });
  });

  it("ignores a stale running report while the round is paused for the user or auth", async () => {
    for (const pauseReason of ["user", "auth"] as const) {
      install();
      storage.seed(
        signedInState({
          syncMeta: {
            ...createDefaultState().syncMeta,
            status: "paused",
            pauseReason,
            startedAt: NOW - 20_000,
            updatedAt: NOW - 500,
          },
        }),
      );

      await applyScrollStatus(scrollStatus(), NOW);

      expect(storage.persisted().syncMeta, pauseReason).toMatchObject({
        status: "paused",
        pauseReason,
        updatedAt: NOW - 500,
      });
    }
  });

  it("keeps a sticky pause reason when a late automatic report arrives", async () => {
    for (const report of [
      scrollStatus({ status: "paused", pauseReason: "budget" }),
      scrollStatus({ status: "paused", pauseReason: "hidden" }),
      scrollStatus({ status: "completed", pauseReason: "stalled", likelyComplete: true }),
    ]) {
      install();
      storage.seed(
        signedInState({
          syncMeta: {
            ...createDefaultState().syncMeta,
            status: "paused",
            pauseReason: "user",
            startedAt: NOW - 20_000,
            updatedAt: NOW - 500,
            stepCount: 7,
          },
        }),
      );

      await applyScrollStatus(report, NOW);

      expect(storage.persisted().syncMeta, report.pauseReason ?? "none").toMatchObject({
        status: "paused",
        pauseReason: "user",
        stepCount: 7,
        updatedAt: NOW - 500,
      });
    }
  });

  it("still records a stop reported while the round is paused for the user", async () => {
    storage.seed(
      signedInState({
        syncMeta: {
          ...createDefaultState().syncMeta,
          status: "paused",
          pauseReason: "user",
          startedAt: NOW - 20_000,
          stepCount: 7,
        },
      }),
    );

    await applyScrollStatus(
      scrollStatus({ status: "stopped", stepCount: 7, pauseReason: null }),
      NOW,
    );

    expect(storage.persisted().syncMeta).toMatchObject({
      status: "stopped",
      pauseReason: null,
      updatedAt: NOW,
    });
  });

  it("accepts the controller's own resume after a hidden pause", async () => {
    storage.seed(
      signedInState({
        syncMeta: {
          ...createDefaultState().syncMeta,
          status: "paused",
          pauseReason: "hidden",
          startedAt: NOW - 20_000,
        },
      }),
    );

    await applyScrollStatus(scrollStatus(), NOW);

    expect(storage.persisted().syncMeta).toMatchObject({
      status: "running",
      pauseReason: null,
      updatedAt: NOW,
    });
  });

  it("stamps the round start when a running report arrives without one", async () => {
    storage.seed(signedInState());

    await applyScrollStatus(scrollStatus(), NOW);

    expect(storage.persisted().syncMeta).toMatchObject({ status: "running", startedAt: NOW });
  });
});

describe("refreshAuth", () => {
  it("asks an open x.com tab to probe auth immediately", async () => {
    install(createTabsMock([{ id: 7, url: "https://x.com/home", active: true }]));

    const result = await refreshAuth();

    expect(result).toEqual({ ok: true, delivered: true });
    expect(tabs.messages).toEqual([{ tabId: 7, message: { type: "AUTH_PROBE" } }]);
  });

  it("refuses when no x.com tab is open", async () => {
    install(createTabsMock([]));

    const result = await refreshAuth();

    expect(result).toEqual({ ok: false, reason: "missing-tab" });
    expect(tabs.messages).toEqual([]);
  });
});

describe("applyAuthStatus", () => {
  it("persists the detected account with the worker clock", async () => {
    storage.seed(createDefaultState());

    await applyAuthStatus(ACCOUNT, 7, NOW);

    expect(storage.persisted().session).toEqual({ account: ACCOUNT, checkedAt: NOW });
  });

  it("pauses a running round when the account becomes unknown", async () => {
    storage.seed(
      signedInState({
        syncMeta: { ...createDefaultState().syncMeta, status: "running", startedAt: NOW - 1_000 },
      }),
    );

    await applyAuthStatus(null, 7, NOW);

    expect(storage.persisted()).toMatchObject({
      session: { account: null, checkedAt: NOW },
      syncMeta: { status: "paused", pauseReason: "auth" },
    });
    expect(tabs.messages).toEqual([
      { tabId: 7, message: { type: "SCROLL_SESSION_PAUSE", reason: "auth" } },
    ]);
  });

  it("keeps the signed-in user's data when the probe only loses the account", async () => {
    storage.seed(
      signedInState({
        following: { "1": contentUser() },
        candidates: ["1"],
        syncMeta: { ...createDefaultState().syncMeta, status: "running", startedAt: NOW - 1_000 },
      }),
    );

    await applyAuthStatus(null, 7, NOW);

    const state = storage.persisted();
    expect(Object.keys(state.following)).toEqual(["1"]);
    expect(state.candidates).toEqual(["1"]);
    expect(state.session.account).toBeNull();
  });

  it("fails closed on an account switch instead of adopting the new identity", async () => {
    storage.seed(
      signedInState({
        following: {
          "1": contentUser(),
          "2": contentUser({ userId: "2", handle: "bob" }),
        },
        candidates: ["1", "2"],
        whitelist: [{ handle: "carol" }],
        syncMeta: {
          ...createDefaultState().syncMeta,
          status: "running",
          startedAt: NOW - 1_000,
          discoveredCount: 2,
        },
      }),
    );

    await applyAuthStatus({ userId: "42", handle: "other" }, 7, NOW);

    const state = storage.persisted();
    expect(state.session).toEqual({ account: null, checkedAt: NOW });
    expect(state.following).toEqual({});
    expect(state.candidates).toEqual([]);
    expect(state.whitelist).toEqual([{ handle: "carol" }]);
    expect(state.syncMeta).toMatchObject({
      status: "paused",
      pauseReason: "auth",
      discoveredCount: 0,
    });
    expect(tabs.types()).toEqual(["SCROLL_SESSION_PAUSE"]);
  });

  it("discards the previous account's data even when no round is in flight", async () => {
    storage.seed(
      signedInState({
        following: { "1": contentUser() },
        candidates: ["1"],
      }),
    );

    await applyAuthStatus({ userId: "42", handle: "other" }, 7, NOW);

    const state = storage.persisted();
    expect(state.session.account).toBeNull();
    expect(state.following).toEqual({});
    expect(state.candidates).toEqual([]);
    expect(state.syncMeta.status).toBe("idle");
    expect(tabs.api.sendMessage).not.toHaveBeenCalled();
  });

  it("adopts the switched account on the next probe, with nothing carried over", async () => {
    storage.seed({
      ...createDefaultState(),
      session: { account: null, checkedAt: NOW - 1 },
    });

    await applyAuthStatus({ userId: "42", handle: "other" }, 7, NOW);

    const state = storage.persisted();
    expect(state.session).toEqual({ account: { userId: "42", handle: "other" }, checkedAt: NOW });
    expect(state.following).toEqual({});
  });

  it("re-sends the scroll command when the same account reports in during a running round", async () => {
    storage.seed(
      signedInState({
        settings: { ...createDefaultState().settings, syncTargetCount: 3_000 },
        syncMeta: { ...createDefaultState().syncMeta, status: "running", startedAt: NOW - 1_000 },
      }),
    );

    await applyAuthStatus(ACCOUNT, 7, NOW);

    expect(tabs.messages).toContainEqual({
      tabId: 7,
      message: { type: "SCROLL_SESSION_START", syncTargetCount: 3_000 },
    });
    expect(storage.persisted().syncMeta.status).toBe("running");
  });

  it("stays quiet when no round is running", async () => {
    storage.seed(signedInState());

    await applyAuthStatus(ACCOUNT, 7, NOW);

    expect(tabs.api.sendMessage).not.toHaveBeenCalled();
  });
});
