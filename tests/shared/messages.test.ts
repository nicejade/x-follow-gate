import { assertNever } from "@/shared/messages";
import type { ExtensionMessage } from "@/shared/messages";

/**
 * Compile-time contract: adding a variant to `ExtensionMessage` without routing
 * it here makes `assertNever` fail to typecheck.
 */
function routeMessage(message: ExtensionMessage): ExtensionMessage["type"] {
  switch (message.type) {
    case "STATE_GET":
    case "SYNC_START":
    case "SYNC_PAUSE":
    case "SYNC_STOP":
    case "FOLLOWING_BATCH":
    case "FOLLOWING_REMOVE":
    case "SCROLL_STATUS":
    case "SCROLL_SESSION_START":
    case "SCROLL_SESSION_PAUSE":
    case "SCROLL_SESSION_STOP":
    case "AUTH_STATUS":
    case "QUEUE_START":
    case "QUEUE_PAUSE":
    case "QUEUE_STOP":
    case "UNFOLLOW_READY":
    case "UNFOLLOW_ONE":
    case "UNFOLLOW_RESULT":
    case "SETTINGS_UPDATE":
    case "WHITELIST_UPDATE":
      return message.type;
    default:
      return assertNever(message);
  }
}

const messages: ExtensionMessage[] = [
  { type: "STATE_GET" },
  { type: "SYNC_START" },
  { type: "SYNC_PAUSE", reason: "hidden" },
  { type: "SYNC_STOP" },
  {
    type: "FOLLOWING_BATCH",
    users: [
      {
        userId: "1",
        handle: "alice",
        name: "Alice",
        avatarUrl: null,
        followedBy: false,
        syncedAt: 1_700_000_000_000,
      },
    ],
  },
  { type: "FOLLOWING_REMOVE", userIds: ["1"] },
  {
    type: "SCROLL_STATUS",
    status: {
      status: "running",
      stepCount: 3,
      discoveredCount: 42,
      noGrowthSteps: 0,
      likelyComplete: false,
      pauseReason: null,
    },
  },
  { type: "SCROLL_SESSION_START", syncTargetCount: 1_000 },
  { type: "SCROLL_SESSION_PAUSE", reason: "auth" },
  { type: "SCROLL_SESSION_STOP" },
  { type: "AUTH_STATUS", account: { userId: "9", handle: "self" } },
  { type: "AUTH_STATUS", account: null },
  { type: "QUEUE_START", userIds: ["1", "2"] },
  { type: "QUEUE_PAUSE", reason: "hourly-cap" },
  { type: "QUEUE_STOP" },
  { type: "UNFOLLOW_READY", tabId: 7, account: { userId: "9", handle: "self" } },
  {
    type: "UNFOLLOW_ONE",
    target: {
      userId: "1",
      handle: "alice",
      name: "Alice",
      avatarUrl: null,
      followedBy: false,
      syncedAt: 1_700_000_000_000,
    },
    account: { userId: "9", handle: "self" },
  },
  {
    type: "UNFOLLOW_RESULT",
    result: { userId: "1", handle: "alice", ok: true, code: "success" },
  },
  {
    type: "SETTINGS_UPDATE",
    settings: {
      preset: "safe",
      intervalMinSec: 90,
      intervalMaxSec: 150,
      hourlyCap: 5,
      dailyCap: 20,
      sessionCap: 10,
      syncTargetCount: 1_000,
      activeHours: { enabled: true, start: "09:00", end: "23:00" },
    },
  },
  { type: "WHITELIST_UPDATE", entries: [{ handle: "alice" }] },
];

describe("ExtensionMessage", () => {
  it("routes every declared variant exhaustively", () => {
    expect(messages.map(routeMessage)).toEqual([
      "STATE_GET",
      "SYNC_START",
      "SYNC_PAUSE",
      "SYNC_STOP",
      "FOLLOWING_BATCH",
      "FOLLOWING_REMOVE",
      "SCROLL_STATUS",
      "SCROLL_SESSION_START",
      "SCROLL_SESSION_PAUSE",
      "SCROLL_SESSION_STOP",
      "AUTH_STATUS",
      "AUTH_STATUS",
      "QUEUE_START",
      "QUEUE_PAUSE",
      "QUEUE_STOP",
      "UNFOLLOW_READY",
      "UNFOLLOW_ONE",
      "UNFOLLOW_RESULT",
      "SETTINGS_UPDATE",
      "WHITELIST_UPDATE",
    ]);
  });

  it("accepts an unknown signed-in account on UNFOLLOW_READY", () => {
    const message: ExtensionMessage = { type: "UNFOLLOW_READY", tabId: 1, account: null };

    expect(routeMessage(message)).toBe("UNFOLLOW_READY");
  });

  it("rejects sync pause reasons the worker derives itself", () => {
    // @ts-expect-error "auth" is derived inside the worker and is not a client command.
    const message: ExtensionMessage = { type: "SYNC_PAUSE", reason: "auth" };

    expect(routeMessage(message)).toBe("SYNC_PAUSE");
  });

  it("rejects unknown message types", () => {
    // @ts-expect-error "PING" is not part of the protocol.
    const message: ExtensionMessage = { type: "PING" };

    expect(() => routeMessage(message)).toThrow();
  });
});

describe("assertNever", () => {
  it("throws with the unhandled value so the failure is diagnosable", () => {
    expect(() => assertNever("SURPRISE" as never)).toThrow(/SURPRISE/);
  });
});
