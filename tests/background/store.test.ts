import {
  applyFollowingBatch,
  loadState,
  recomputeCandidates,
  removeFollowingUsers,
  replaceState,
  updateState,
} from "@/background/store";
import { createDefaultSettings, createDefaultState, DEFAULT_SCAN_STRATEGIES, STATE_STORAGE_KEY, STATE_VERSION } from "@/shared/defaults";
import { HARD_LIMITS, SAFE_SETTINGS } from "@/shared/safety";
import type { ExtensionState, FollowingUser, RelationshipState, Settings } from "@/shared/types";

const SAFE_SETTINGS_SNAPSHOT = structuredClone(SAFE_SETTINGS);

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

function unsafeSettings(): Settings {
  return {
    preset: "custom",
    intervalMinSec: 1,
    intervalMaxSec: 2,
    hourlyCap: 99,
    dailyCap: 99,
    sessionCap: 99,
    syncTargetCount: 1_000,
    activeHours: { enabled: true, start: "09:00", end: "23:00" },
    scanStrategies: { ...DEFAULT_SCAN_STRATEGIES },
  };
}

/**
 * Minimal `chrome.storage.local` double. Values are structurally cloned on both
 * read and write so a test can never observe a live in-memory reference, and
 * writes resolve on a later macrotask so overlapping updates would be visible
 * as a lost update.
 */
function createStorageMock() {
  const records = new Map<string, unknown>();

  const local = {
    get: vi.fn((key: string) => {
      const value = records.get(key);
      return Promise.resolve(value === undefined ? {} : { [key]: structuredClone(value) });
    }),
    set: vi.fn(async (items: Record<string, unknown>) => {
      await new Promise((resolve) => setTimeout(resolve, 0));
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
    persisted(): ExtensionState | undefined {
      return records.get(STATE_STORAGE_KEY) as ExtensionState | undefined;
    },
  };
}

let storage: ReturnType<typeof createStorageMock>;

beforeEach(() => {
  storage = createStorageMock();
  vi.stubGlobal("chrome", { storage: { local: storage.local } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  expect(SAFE_SETTINGS).toEqual(SAFE_SETTINGS_SNAPSHOT);
});

describe("loadState", () => {
  it("hydrates the default state when nothing is persisted yet", async () => {
    await expect(loadState()).resolves.toEqual(createDefaultState());
  });

  it("hydrates defaults when the persisted value is not a state object", async () => {
    storage.seed("corrupted");

    await expect(loadState()).resolves.toEqual(createDefaultState());
  });

  it("fills missing sections of a partially persisted state", async () => {
    storage.seed({ version: STATE_VERSION, whitelist: [{ handle: "alice" }] });

    const state = await loadState();

    expect(state.whitelist).toEqual([{ handle: "alice" }]);
    expect(state.following).toEqual({});
    expect(state.unfollowQueue).toEqual(createDefaultState().unfollowQueue);
    expect(state.settings).toEqual(createDefaultState().settings);
  });

  it("clamps persisted settings that would bypass the safety floors", async () => {
    storage.seed({ ...createDefaultState(), settings: unsafeSettings() });

    const { settings } = await loadState();

    expect(settings.intervalMinSec).toBe(HARD_LIMITS.minIntervalSec);
    expect(settings.hourlyCap).toBe(HARD_LIMITS.maxHourlyCap);
    expect(settings.dailyCap).toBe(HARD_LIMITS.maxDailyCap);
    expect(settings.sessionCap).toBe(HARD_LIMITS.maxSessionCap);
  });

  it("hydrates legacy settings without syncTargetCount", async () => {
    storage.seed({
      ...createDefaultState(),
      settings: {
        preset: "safe",
        intervalMinSec: 90,
        intervalMaxSec: 150,
        hourlyCap: 5,
        dailyCap: 20,
        sessionCap: 10,
        activeHours: { enabled: true, start: "09:00", end: "23:00" },
      } as Settings,
    });

    expect((await loadState()).settings.syncTargetCount).toBe(1_000);
  });

  it("turns off the hidden v1 active-hours window on hydrate", async () => {
    storage.seed({
      ...createDefaultState(),
      version: 1,
      settings: {
        ...createDefaultState().settings,
        activeHours: { enabled: true, start: "09:00", end: "23:00" },
      },
    });

    expect((await loadState()).settings.activeHours.enabled).toBe(false);
    expect((await loadState()).version).toBe(STATE_VERSION);
  });

  it("hydrates legacy v2 state with default scan strategies", async () => {
    const legacy = createDefaultState();
    legacy.version = 2;
    delete (legacy.settings as Partial<Settings>).scanStrategies;
    storage.seed(legacy);

    expect((await loadState()).settings.scanStrategies).toEqual(DEFAULT_SCAN_STRATEGIES);
    expect((await loadState()).version).toBe(STATE_VERSION);
  });

  it("normalizes legacy following records with missing profile fields", async () => {
    storage.seed({
      ...createDefaultState(),
      following: {
        "1": {
          userId: "1",
          handle: "alice",
          name: "Alice",
          avatarUrl: null,
          followedBy: false,
          syncedAt: 1_700_000_000_000,
        },
      },
    });

    const { following } = await loadState();

    expect(following["1"]).toMatchObject({
      isBlueVerified: null,
      protected: null,
      statusesCount: null,
      friendsCount: null,
      followersCount: null,
    });
  });

  it("normalizes persisted following records the same way a batch is normalized", async () => {
    storage.seed({
      ...createDefaultState(),
      following: { " 1 ": { ...user(" 1 ", "@ALICE", false) } },
    });

    const { following } = await loadState();

    expect(Object.keys(following)).toEqual(["1"]);
    expect(following["1"]).toMatchObject({ userId: "1", handle: "alice" });
  });

  it("drops persisted following records that could never be written today", async () => {
    storage.seed({
      ...createDefaultState(),
      following: {
        "": user("", "blank", false),
        "   ": user("   ", "spaces", false),
        broken: user("broken", "no-relationship", "maybe" as unknown as RelationshipState),
        stale: { ...user("stale", "unstamped", false), syncedAt: Number.NaN },
        "2": user("2", "bob", false),
      },
    });

    const state = await loadState();

    expect(Object.keys(state.following)).toEqual(["2"]);
  });

  it("returns a detached copy so callers cannot mutate persisted state", async () => {
    const first = await loadState();
    first.candidates.push("leaked");

    await expect(loadState()).resolves.toEqual(createDefaultState());
  });
});

describe("replaceState", () => {
  it("persists the whole tree under the state storage key", async () => {
    const next: ExtensionState = { ...createDefaultState(), candidates: ["1"] };

    await replaceState(next);

    expect(storage.local.set).toHaveBeenCalledWith({ [STATE_STORAGE_KEY]: next });
    expect(storage.persisted()?.candidates).toEqual(["1"]);
  });

  it("never persists settings that bypass the safety floors", async () => {
    await replaceState({ ...createDefaultState(), settings: unsafeSettings() });

    expect(storage.persisted()?.settings.hourlyCap).toBe(HARD_LIMITS.maxHourlyCap);
    expect(storage.persisted()?.settings.intervalMinSec).toBe(HARD_LIMITS.minIntervalSec);
  });
});

describe("updateState", () => {
  it("returns and persists the mutated state", async () => {
    const next = await updateState((state) => ({ ...state, candidates: ["7"] }));

    expect(next.candidates).toEqual(["7"]);
    expect(storage.persisted()?.candidates).toEqual(["7"]);
  });

  it("clamps settings written through a mutator", async () => {
    const next = await updateState((state) => ({ ...state, settings: unsafeSettings() }));

    expect(next.settings.hourlyCap).toBe(HARD_LIMITS.maxHourlyCap);
    expect(storage.persisted()?.settings.sessionCap).toBe(HARD_LIMITS.maxSessionCap);
  });

  it("serializes overlapping updates so neither mutation is lost", async () => {
    const first = updateState((state) => ({ ...state, candidates: [...state.candidates, "a"] }));
    const second = updateState((state) => ({ ...state, candidates: [...state.candidates, "b"] }));

    const [, secondState] = await Promise.all([first, second]);

    expect(secondState.candidates).toEqual(["a", "b"]);
    await expect(loadState()).resolves.toMatchObject({ candidates: ["a", "b"] });
  });

  it("reloads persisted state on every operation so a worker restart cannot use a stale snapshot", async () => {
    storage.seed({ ...createDefaultState(), candidates: ["external"] });

    const next = await updateState((state) => ({
      ...state,
      candidates: [...state.candidates, "local"],
    }));

    expect(next.candidates).toEqual(["external", "local"]);
  });

  it("keeps the chain usable after a mutator throws", async () => {
    const failure = updateState(() => {
      throw new Error("mutator failed");
    });
    const recovery = updateState((state) => ({ ...state, candidates: ["after-failure"] }));

    await expect(failure).rejects.toThrow("mutator failed");
    await expect(recovery).resolves.toMatchObject({ candidates: ["after-failure"] });
    expect(storage.persisted()?.candidates).toEqual(["after-failure"]);
  });
});

describe("applyFollowingBatch", () => {
  it("merges users by id and recomputes candidates from explicit non-followers only", () => {
    const state = applyFollowingBatch(createDefaultState(), [
      user("1", "mutual", true),
      user("2", "candidate", false),
      user("3", "unknown", null),
    ]);

    expect(Object.keys(state.following)).toEqual(["1", "2", "3"]);
    expect(state.candidates).toEqual(["2"]);
  });

  it("never turns an unknown relationship into a candidate", () => {
    const state = applyFollowingBatch(createDefaultState(), [
      user("1", "unknown-a", null),
      user("2", "unknown-b", null),
    ]);

    expect(state.candidates).toEqual([]);
  });

  it("excludes whitelisted users regardless of @ prefix and letter case", () => {
    const seeded: ExtensionState = { ...createDefaultState(), whitelist: [{ handle: "@ALICE" }] };

    const state = applyFollowingBatch(seeded, [user("1", "alice", false), user("2", "bob", false)]);

    expect(state.candidates).toEqual(["2"]);
  });

  it("keeps the newer observation when batches arrive out of order", () => {
    const first = applyFollowingBatch(createDefaultState(), [user("1", "alice", false, { syncedAt: 2_000 })]);
    const second = applyFollowingBatch(first, [user("1", "alice", true, { syncedAt: 1_000 })]);

    expect(second.following["1"]?.followedBy).toBe(false);
    expect(second.following["1"]?.syncedAt).toBe(2_000);

    const third = applyFollowingBatch(second, [user("1", "alice", true, { syncedAt: 3_000 })]);

    expect(third.following["1"]?.followedBy).toBe(true);
    expect(third.candidates).toEqual([]);
  });

  it("ignores entries without a usable user id", () => {
    const state = applyFollowingBatch(createDefaultState(), [
      user("   ", "blank", false),
      user("2", "bob", false),
    ]);

    expect(Object.keys(state.following)).toEqual(["2"]);
  });

  it("does not mutate the state it is given", () => {
    const before = createDefaultState();
    const snapshot = structuredClone(before);

    applyFollowingBatch(before, [user("1", "alice", false)]);

    expect(before).toEqual(snapshot);
  });

  it("persists merged users and candidates through updateState", async () => {
    const next = await updateState((state) =>
      applyFollowingBatch(state, [user("1", "alice", false), user("2", "bob", true)]),
    );

    expect(next.candidates).toEqual(["1"]);
    expect(storage.persisted()?.candidates).toEqual(["1"]);
    expect(Object.keys(storage.persisted()?.following ?? {})).toEqual(["1", "2"]);
  });
});

describe("recomputeCandidates", () => {
  it("drops a user that was just added to the whitelist", () => {
    const synced = applyFollowingBatch(createDefaultState(), [
      user("1", "alice", false),
      user("2", "bob", false),
    ]);
    expect(synced.candidates).toEqual(["1", "2"]);

    const protectedState = recomputeCandidates({ ...synced, whitelist: [{ userId: "1" }] });

    expect(protectedState.candidates).toEqual(["2"]);
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
});

describe("removeFollowingUsers", () => {
  it("removes users from the following map and refreshes candidates", () => {
    const synced = applyFollowingBatch(createDefaultState(), [
      user("1", "alice", false),
      user("2", "bob", false),
    ]);

    const next = removeFollowingUsers(synced, ["1"]);

    expect(next.following["1"]).toBeUndefined();
    expect(next.following["2"]).toBeDefined();
    expect(next.candidates).toEqual(["2"]);
  });

  it("returns the same state when nothing is removed", () => {
    const synced = applyFollowingBatch(createDefaultState(), [user("1", "alice", false)]);

    expect(removeFollowingUsers(synced, [])).toBe(synced);
    expect(removeFollowingUsers(synced, ["9"])).toBe(synced);
  });
});
