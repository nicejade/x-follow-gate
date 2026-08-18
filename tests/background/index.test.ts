import { createDefaultState, STATE_STORAGE_KEY } from "@/shared/defaults";
import { UNFOLLOW_ALARM_NAME } from "@/background/queue";
import type { ExtensionState } from "@/shared/types";

interface ListenerMap {
  onMessage: Array<
    (message: unknown, sender: unknown, sendResponse: (value: unknown) => void) => unknown
  >;
  onAlarm: Array<(alarm: { name: string }) => void>;
  onClicked: Array<(tab: { windowId?: number }) => void>;
  onUpdated: Array<(tabId: number, change: { status?: string }) => void>;
  onInstalled: Array<() => void>;
}

function createChromeMock(state: ExtensionState = createDefaultState()) {
  const listeners: ListenerMap = {
    onMessage: [],
    onAlarm: [],
    onClicked: [],
    onUpdated: [],
    onInstalled: [],
  };
  const alarms: Array<{ name: string; when: number }> = [];
  const opened: number[] = [];
  const records = new Map<string, unknown>([[STATE_STORAGE_KEY, structuredClone(state)]]);

  const api = {
    runtime: {
      id: "follow-gate-test",
      onInstalled: {
        addListener: (listener: () => void) => {
          listeners.onInstalled.push(listener);
        },
      },
      onMessage: {
        addListener: (
          listener: (
            message: unknown,
            sender: unknown,
            sendResponse: (value: unknown) => void,
          ) => unknown,
        ) => {
          listeners.onMessage.push(listener);
        },
      },
    },
    alarms: {
      onAlarm: {
        addListener: (listener: (alarm: { name: string }) => void) => {
          listeners.onAlarm.push(listener);
        },
      },
      create: vi.fn(async (name: string, info: { when: number }) => {
        alarms.push({ name, when: info.when });
      }),
      clear: vi.fn(async (name: string) => {
        const index = alarms.findIndex((alarm) => alarm.name === name);
        if (index >= 0) {
          alarms.splice(index, 1);
        }
        return true;
      }),
    },
    action: {
      onClicked: {
        addListener: (listener: (tab: { windowId?: number }) => void) => {
          listeners.onClicked.push(listener);
        },
      },
    },
    tabs: {
      onUpdated: {
        addListener: (listener: (tabId: number, change: { status?: string }) => void) => {
          listeners.onUpdated.push(listener);
        },
      },
      query: vi.fn(async () => []),
    },
    sidePanel: {
      open: vi.fn(async ({ windowId }: { windowId: number }) => {
        opened.push(windowId);
      }),
    },
    storage: {
      local: {
        get: vi.fn(async (key: string) => {
          const value = records.get(key);
          return value === undefined ? {} : { [key]: structuredClone(value) };
        }),
        set: vi.fn(async (items: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(items)) {
            records.set(key, structuredClone(value));
          }
        }),
      },
    },
  };

  return { api, listeners, alarms, opened, records };
}

async function loadWorker(state?: ExtensionState) {
  vi.resetModules();
  const chromeMock = createChromeMock(state);
  vi.stubGlobal("chrome", chromeMock.api);
  const worker = await import("@/background/index");

  return { chromeMock, worker };
}

describe("background listeners", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("registers every required listener on import", async () => {
    const { chromeMock } = await loadWorker();

    expect(chromeMock.listeners.onInstalled).toHaveLength(1);
    expect(chromeMock.listeners.onMessage).toHaveLength(1);
    expect(chromeMock.listeners.onAlarm).toHaveLength(1);
    expect(chromeMock.listeners.onClicked).toHaveLength(1);
    expect(chromeMock.listeners.onUpdated).toHaveLength(1);
  });

  it("keeps the message channel open for async handlers", async () => {
    const { chromeMock } = await loadWorker();
    const sendResponse = vi.fn();

    const keepAlive = chromeMock.listeners.onMessage[0]?.({ type: "STATE_GET" }, {}, sendResponse);

    expect(keepAlive).toBe(true);
    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalledWith({
        ok: true,
        result: expect.objectContaining({ version: 2 }),
      });
    });
  });

  it("returns a typed error for unknown messages instead of throwing", async () => {
    const { chromeMock } = await loadWorker();
    const sendResponse = vi.fn();

    expect(() =>
      chromeMock.listeners.onMessage[0]?.({ type: "NOT_A_REAL_MESSAGE" }, {}, sendResponse),
    ).not.toThrow();

    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalledWith({
        ok: false,
        error: { code: "unknown-message" },
      });
    });
  });

  it("ignores alarms that are not the unfollow tick", async () => {
    const { chromeMock, worker } = await loadWorker();

    await worker.handleAlarm({ name: "other-alarm" });

    expect(chromeMock.alarms).toHaveLength(0);
  });

  it("does not auto-run a paused, stopped, or cooling-down queue on startup", async () => {
    const paused = createDefaultState();
    paused.unfollowQueue.status = "paused";
    paused.unfollowQueue.nextAt = Date.now() - 1_000;
    paused.unfollowQueue.pauseReason = "user";

    const { chromeMock } = await loadWorker(paused);
    chromeMock.listeners.onInstalled[0]?.();
    await vi.waitFor(() => {
      expect(chromeMock.api.alarms.clear).toHaveBeenCalledWith(UNFOLLOW_ALARM_NAME);
    });

    expect(chromeMock.api.alarms.create).not.toHaveBeenCalled();
  });

  it("opens the side panel from the action click", async () => {
    const { chromeMock } = await loadWorker();

    chromeMock.listeners.onClicked[0]?.({ windowId: 12 });
    await vi.waitFor(() => {
      expect(chromeMock.opened).toEqual([12]);
    });
  });
});
