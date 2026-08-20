import {
  isProfileUrl,
  isXTabUrl,
  profileUrl,
  routeToProfile,
  sendUnfollowOne,
} from "@/background/tab-router";
import type { ExtensionMessage } from "@/shared/messages";
import type { AccountIdentity, FollowingUser } from "@/shared/types";

const OWNER: AccountIdentity = { userId: "9", handle: "self" };

function target(overrides: Partial<FollowingUser> = {}): FollowingUser {
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

interface FakeTab {
  id: number;
  url: string;
  active: boolean;
  status: string;
}

function createTabsMock(initial: Array<Partial<FakeTab>> = []) {
  let nextId = 100;
  const tabs: FakeTab[] = initial.map((tab) => ({
    id: tab.id ?? nextId++,
    url: tab.url ?? "https://x.com/home",
    active: tab.active ?? false,
    status: tab.status ?? "complete",
  }));
  const messages: Array<{ tabId: number; message: ExtensionMessage }> = [];
  const updates: Array<{ tabId: number; url?: string; active?: boolean }> = [];
  let deliverable = true;

  const api = {
    query: vi.fn(async () => tabs.map((tab) => ({ ...tab }))),
    get: vi.fn(async (tabId: number) => {
      const tab = tabs.find((candidate) => candidate.id === tabId);
      if (tab === undefined) {
        throw new Error(`No tab with id: ${tabId}.`);
      }

      return { ...tab };
    }),
    create: vi.fn(async (properties: { url?: string; active?: boolean }) => {
      const tab: FakeTab = {
        id: nextId++,
        url: properties.url ?? "https://x.com/home",
        active: properties.active ?? true,
        status: "complete",
      };
      tabs.push(tab);

      return { ...tab };
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
      if (!deliverable) {
        throw new Error("Could not establish connection. Receiving end does not exist.");
      }

      messages.push({ tabId, message });

      return { accepted: true };
    }),
  };

  return {
    api,
    tabs,
    messages,
    updates,
    breakDelivery() {
      deliverable = false;
    },
  };
}

let tabs: ReturnType<typeof createTabsMock>;

function install(mock: ReturnType<typeof createTabsMock>) {
  tabs = mock;
  vi.stubGlobal("chrome", { tabs: mock.api });
}

/** Deterministic readiness wait: the poll advances without touching real timers. */
const instantWait = async (): Promise<void> => {
  await Promise.resolve();
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("profileUrl", () => {
  it("builds the canonical profile URL from a normalized handle", () => {
    expect(profileUrl("Alice")).toBe("https://x.com/alice");
    expect(profileUrl("@alice ")).toBe("https://x.com/alice");
  });
});

describe("isProfileUrl", () => {
  it("accepts the profile page across hosts, casing and a trailing slash", () => {
    for (const url of [
      "https://x.com/alice",
      "https://x.com/Alice/",
      "https://twitter.com/alice",
      "https://x.com/alice?foo=bar",
    ]) {
      expect(isProfileUrl(url, "alice"), url).toBe(true);
    }
  });

  it("rejects other pages, other accounts and non-X hosts", () => {
    for (const url of [
      "https://x.com/alice/following",
      "https://x.com/alice/status/1",
      "https://x.com/bob",
      "https://evil.example/alice",
      "http://x.com/alice",
      undefined,
    ]) {
      expect(isProfileUrl(url, "alice"), String(url)).toBe(false);
    }
  });
});

describe("isXTabUrl", () => {
  it("accepts only https X hosts", () => {
    expect(isXTabUrl("https://x.com/home")).toBe(true);
    expect(isXTabUrl("https://mobile.twitter.com/home")).toBe(true);
    expect(isXTabUrl("http://x.com/home")).toBe(false);
    expect(isXTabUrl("https://evil.example/x.com")).toBe(false);
    expect(isXTabUrl(undefined)).toBe(false);
  });
});

describe("routeToProfile", () => {
  it("navigates the existing X tab to the profile and brings it to the front", async () => {
    install(createTabsMock([{ id: 5, url: "https://x.com/home" }]));

    const route = await routeToProfile("alice", { wait: instantWait });

    expect(route).toEqual({ ok: true, tabId: 5 });
    expect(tabs.updates).toEqual([{ tabId: 5, url: "https://x.com/alice", active: true }]);
    expect(tabs.api.create).not.toHaveBeenCalled();
  });

  it("never opens a second tab, even when several X tabs are open", async () => {
    install(
      createTabsMock([
        { id: 5, url: "https://x.com/home" },
        { id: 6, url: "https://x.com/explore", active: true },
      ]),
    );

    const route = await routeToProfile("alice", { wait: instantWait });

    expect(route).toEqual({ ok: true, tabId: 6 });
    expect(tabs.api.create).not.toHaveBeenCalled();
    expect(tabs.updates).toHaveLength(1);
  });

  it("reuses a tab already showing the profile without navigating it again", async () => {
    install(createTabsMock([{ id: 5, url: "https://x.com/alice" }]));

    const route = await routeToProfile("alice", { wait: instantWait });

    expect(route).toEqual({ ok: true, tabId: 5 });
    expect(tabs.updates).toEqual([{ tabId: 5, active: true }]);
  });

  it("opens an X tab when no context exists", async () => {
    install(createTabsMock([{ id: 5, url: "https://example.com/" }]));

    const route = await routeToProfile("alice", { wait: instantWait });

    expect(route).toEqual({ ok: true, tabId: expect.any(Number) });
    expect(tabs.api.create).toHaveBeenCalledWith({
      url: "https://x.com/alice",
      active: true,
    });
  });

  it("reports missing-tab when the tab disappears while it is being routed", async () => {
    install(createTabsMock([{ id: 5, url: "https://x.com/home" }]));
    tabs.api.update.mockRejectedValueOnce(new Error("No tab with id: 5."));

    const route = await routeToProfile("alice", { wait: instantWait });

    expect(route).toEqual({ ok: false, reason: "missing-tab" });
  });

  it("waits for the navigation to finish before reporting the tab as ready", async () => {
    install(createTabsMock([{ id: 5, url: "https://x.com/home", status: "loading" }]));
    let reads = 0;
    tabs.api.get.mockImplementation(async () => {
      reads += 1;

      return {
        id: 5,
        url: "https://x.com/alice",
        active: true,
        status: reads < 3 ? "loading" : "complete",
      };
    });

    const route = await routeToProfile("alice", { wait: instantWait });

    expect(route).toEqual({ ok: true, tabId: 5 });
    expect(reads).toBe(3);
  });

  it("gives up with missing-tab when readiness never arrives", async () => {
    install(createTabsMock([{ id: 5, url: "https://x.com/home", status: "loading" }]));
    tabs.api.get.mockImplementation(async () => ({
      id: 5,
      url: "https://x.com/alice",
      active: true,
      status: "loading",
    }));

    const route = await routeToProfile("alice", { wait: instantWait, attempts: 4 });

    expect(route).toEqual({ ok: false, reason: "missing-tab" });
    expect(tabs.api.get).toHaveBeenCalledTimes(4);
  });

  it("gives up with missing-tab when the tab navigated somewhere else", async () => {
    install(createTabsMock([{ id: 5, url: "https://x.com/home" }]));
    tabs.api.get.mockImplementation(async () => ({
      id: 5,
      url: "https://x.com/i/flow/login",
      active: true,
      status: "complete",
    }));

    const route = await routeToProfile("alice", { wait: instantWait, attempts: 2 });

    expect(route).toEqual({ ok: false, reason: "missing-tab" });
  });
});

describe("sendUnfollowOne", () => {
  const INTERVAL = { intervalMinSec: 3, intervalMaxSec: 12 };

  it("sends exactly one command carrying the target and the owner account", async () => {
    install(createTabsMock([{ id: 5, url: "https://x.com/alice" }]));

    const delivered = await sendUnfollowOne(5, target(), OWNER, INTERVAL);

    expect(delivered).toBe(true);
    expect(tabs.messages).toEqual([
      {
        tabId: 5,
        message: {
          type: "UNFOLLOW_ONE",
          target: target(),
          account: OWNER,
          ...INTERVAL,
        },
      },
    ]);
    expect(tabs.api.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("does not treat a send as delivered unless the content script accepts it", async () => {
    install(createTabsMock([{ id: 5, url: "https://x.com/alice" }]));
    tabs.api.sendMessage.mockResolvedValueOnce({ accepted: false });

    await expect(sendUnfollowOne(5, target(), OWNER, INTERVAL, { attempts: 1 })).resolves.toBe(false);
  });

  it("reports an undelivered command instead of throwing", async () => {
    install(createTabsMock([{ id: 5, url: "https://x.com/alice" }]));
    tabs.breakDelivery();

    await expect(sendUnfollowOne(5, target(), OWNER, INTERVAL)).resolves.toBe(false);
  });
});
