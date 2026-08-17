import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import { App } from "@/sidepanel/App";
import { createDefaultState } from "@/shared/defaults";
import type { ExtensionMessage } from "@/shared/messages";
import type { ExtensionState, FollowingUser } from "@/shared/types";

const messages: ExtensionMessage[] = [];
let currentState: ExtensionState;
let respond: (() => void) | null = null;
const changeListeners: Array<
  (changes: Record<string, { newValue: unknown }>, area: string) => void
> = [];

function user(userId: string, handle: string, followedBy: boolean | null): FollowingUser {
  return {
    userId,
    handle,
    name: handle,
    avatarUrl: null,
    followedBy,
    syncedAt: 1,
  };
}

function signedInState(overrides: Partial<ExtensionState> = {}): ExtensionState {
  const alice = user("2", "alice", false);
  const bob = user("3", "bob", false);
  const mutual = user("4", "mutual", true);
  const ghost = user("5", "ghost", null);

  return {
    ...createDefaultState(),
    session: { account: { userId: "9", handle: "self" }, checkedAt: 1 },
    following: {
      "2": alice,
      "3": bob,
      "4": mutual,
      "5": ghost,
    },
    candidates: ["2", "3"],
    ...overrides,
  };
}

function installChrome(state: ExtensionState, delayResponse = false) {
  currentState = state;
  messages.length = 0;
  respond = null;
  changeListeners.length = 0;

  vi.stubGlobal("chrome", {
    runtime: {
      sendMessage: vi.fn((message: ExtensionMessage, callback?: (response: unknown) => void) => {
        messages.push(message);
        if (message.type !== "STATE_GET") {
          return;
        }
        const payload = { ok: true, result: currentState };
        if (delayResponse) {
          respond = () => callback?.(payload);
          return;
        }
        callback?.(payload);
      }),
    },
    storage: {
      onChanged: {
        addListener: (listener: (typeof changeListeners)[number]) => {
          changeListeners.push(listener);
        },
        removeListener: (listener: (typeof changeListeners)[number]) => {
          const index = changeListeners.indexOf(listener);
          if (index >= 0) {
            changeListeners.splice(index, 1);
          }
        },
      },
    },
  });
}

async function renderReadyApp() {
  render(<App />);
  await waitFor(() => {
    expect(screen.queryByText("正在读取本地状态…")).not.toBeInTheDocument();
  });
}

function pushState(next: ExtensionState) {
  currentState = next;
  for (const listener of changeListeners) {
    listener({ extensionState: { newValue: next } }, "local");
  }
}

describe("Side Panel", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows a loading state until STATE_GET returns", async () => {
    installChrome(signedInState(), true);
    render(<App />);
    expect(screen.getByText("正在读取本地状态…")).toBeInTheDocument();
    respond?.();
    await waitFor(() => {
      expect(screen.getByText("关注门卫")).toBeInTheDocument();
    });
  });

  it("shows an unauthenticated banner", async () => {
    installChrome(createDefaultState());
    await renderReadyApp();
    expect(screen.getByText("未登录")).toBeInTheDocument();
    expect(screen.getByText(/请先在 x.com 登录/)).toBeInTheDocument();
  });

  it("renders insight metrics over known relationships only", async () => {
    installChrome(signedInState());
    await renderReadyApp();
    expect(screen.getByText("已同步")).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument();
    expect(screen.getByText("未回关")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("互关率")).toBeInTheDocument();
    expect(screen.getByText("33%")).toBeInTheDocument();
    expect(screen.getByText("关系未知")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.getByText(/将打开关注列表并渐进滚动采集|已发现/)).toBeInTheDocument();
  });

  it("pauses a live sync and explains a hidden tab", async () => {
    const syncing = signedInState({
      syncMeta: {
        ...createDefaultState().syncMeta,
        status: "running",
        discoveredCount: 12,
      },
    });
    installChrome(syncing);
    await renderReadyApp();
    expect(screen.getByText(/已发现 12 人/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "暂停" }));
    expect(messages.some((message) => message.type === "SYNC_PAUSE")).toBe(true);

    pushState({
      ...syncing,
      syncMeta: { ...syncing.syncMeta, status: "paused", pauseReason: "hidden" },
    });
    await waitFor(() => {
      expect(screen.getByText(/已隐藏超过 45 秒/)).toBeInTheDocument();
    });
  });

  it("disables sync while the unfollow queue is running", async () => {
    installChrome(
      signedInState({
        unfollowQueue: {
          ...createDefaultState().unfollowQueue,
          status: "running",
        },
      }),
    );
    await renderReadyApp();
    expect(screen.getByRole("button", { name: "同步 Following" })).toBeDisabled();
    expect(screen.getByText(/取关队列进行中/)).toBeInTheDocument();
  });

  it("lists only explicit non-followers and confirms before starting", async () => {
    installChrome(signedInState({ whitelist: [{ handle: "bob" }] }));
    await renderReadyApp();
    fireEvent.click(screen.getByRole("button", { name: "清理" }));
    expect(screen.getByText("@alice · 未回关")).toBeInTheDocument();
    expect(screen.queryByText("@bob · 未回关")).not.toBeInTheDocument();
    expect(screen.queryByText("@ghost")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "预览并开始" }));
    expect(screen.getByText(/无法保证零风险/)).toBeInTheDocument();
    expect(screen.getByText(/档位 安全/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认并开始" }));
    expect(messages).toContainEqual({ type: "QUEUE_START", userIds: ["2"] });
  });

  it("disables start during cooldown and never offers ignore-and-continue", async () => {
    const until = Date.now() + 60 * 60 * 1000;
    installChrome(
      signedInState({
        unfollowQueue: {
          ...createDefaultState().unfollowQueue,
          status: "cooldown",
          cooldownUntil: until,
          pauseReason: "rate-limited",
        },
      }),
    );
    await renderReadyApp();
    fireEvent.click(screen.getByRole("button", { name: "清理" }));
    expect(screen.getByRole("button", { name: "预览并开始" })).toBeDisabled();
    expect(screen.getByText(/熔断中/)).toBeInTheDocument();
    expect(screen.queryByText(/忽略并继续/)).not.toBeInTheDocument();
  });

  it("whitelists a candidate from the cleanup list", async () => {
    installChrome(signedInState());
    await renderReadyApp();
    fireEvent.click(screen.getByRole("button", { name: "清理" }));
    fireEvent.click(screen.getAllByRole("button", { name: "白名单" })[0]!);
    expect(messages.some((message) => message.type === "WHITELIST_UPDATE")).toBe(true);
  });
});
