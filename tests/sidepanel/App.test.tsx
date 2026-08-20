import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import { App } from "@/sidepanel/App";
import { createDefaultState } from "@/shared/defaults";
import type { ExtensionMessage } from "@/shared/messages";
import type { ExtensionState, FollowingUser } from "@/shared/types";

const messages: ExtensionMessage[] = [];
const commandReplies = new Map<ExtensionMessage["type"], unknown>();
let currentState: ExtensionState;
let respond: (() => void) | null = null;
const changeListeners: Array<
  (changes: Record<string, { newValue: unknown }>, area: string) => void
> = [];

function user(
  userId: string,
  handle: string,
  followedBy: boolean | null,
  overrides: Partial<FollowingUser> = {},
): FollowingUser {
  return {
    userId,
    handle,
    name: handle,
    avatarUrl: null,
    followedBy,
    isBlueVerified: null,
    protected: null,
    statusesCount: null,
    friendsCount: null,
    followersCount: null,
    syncedAt: 1,
    ...overrides,
  };
}

const ALL_STRATEGIES_ON = {
  notFollowingBack: true,
  nonBlueVerified: true,
  protected: true,
  lowTweetCount: true,
  followRatio: true,
};

function mixedStrategyState(): ExtensionState {
  return signedInState({
    settings: {
      ...createDefaultState().settings,
      scanStrategies: ALL_STRATEGIES_ON,
    },
    following: {
      pr: user("pr", "locked", true, {
        isBlueVerified: true,
        protected: true,
        statusesCount: 100,
        friendsCount: 10,
        followersCount: 10,
      }),
      nb: user("nb", "plain", true, {
        isBlueVerified: false,
        protected: false,
        statusesCount: 100,
        friendsCount: 10,
        followersCount: 10,
      }),
      nf: user("nf", "ghosted", false, {
        isBlueVerified: true,
        protected: false,
        statusesCount: 100,
        friendsCount: 10,
        followersCount: 10,
      }),
    },
    candidates: ["pr", "nb", "nf"],
  });
}

function listedHandles(): string[] {
  return screen
    .getAllByRole("checkbox", { name: /选择 @/ })
    .map((checkbox) => checkbox.getAttribute("aria-label") ?? "");
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
  commandReplies.clear();

  vi.stubGlobal("chrome", {
    runtime: {
      sendMessage: vi.fn((message: ExtensionMessage, callback?: (response: unknown) => void) => {
        messages.push(message);
        if (message.type !== "STATE_GET") {
          // The worker answers every command; a refusal travels as a result.
          // A seeded `undefined` reply stands for a worker that never answered.
          callback?.(
            commandReplies.has(message.type)
              ? commandReplies.get(message.type)
              : {
                  ok: true,
                  result: {
                    ok: true,
                    plan: { action: "execute", nextAt: Date.now() + 30_000 },
                  },
                },
          );
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
    expect(screen.getByText("待清理候选")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("互关率")).toBeInTheDocument();
    expect(screen.getByText("33%")).toBeInTheDocument();
    expect(screen.getByText("关系未知")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.getByText(/将打开关注列表并渐进滚动采集|已发现/)).toBeInTheDocument();
  });

  it("acknowledges a second Following sync instead of looking idle", async () => {
    installChrome(
      signedInState({
        syncMeta: {
          ...createDefaultState().syncMeta,
          status: "completed",
          likelyComplete: true,
          pauseReason: "stalled",
          discoveredCount: 4,
        },
      }),
    );
    commandReplies.set("SYNC_START", { ok: true, result: { ok: true, tabId: 7, delivered: true } });
    await renderReadyApp();

    fireEvent.click(screen.getByRole("button", { name: "同步 Following" }));

    await waitFor(() => {
      expect(messages).toContainEqual(expect.objectContaining({ type: "SYNC_START" }));
      expect(screen.getByText(/已开始同步/)).toBeInTheDocument();
    });
  });

  it("sends forceReload when the checkbox is checked", async () => {
    installChrome(signedInState());
    commandReplies.set("SYNC_START", { ok: true, result: { ok: true, tabId: 7, delivered: true } });
    await renderReadyApp();

    fireEvent.click(screen.getByLabelText("强制重新加载关注列表"));
    fireEvent.click(screen.getByRole("button", { name: "同步 Following" }));

    await waitFor(() => {
      expect(messages).toContainEqual({ type: "SYNC_START", forceReload: true });
    });
  });

  it("sends forceReload false when the checkbox is unchecked", async () => {
    installChrome(signedInState());
    commandReplies.set("SYNC_START", { ok: true, result: { ok: true, tabId: 7, delivered: true } });
    await renderReadyApp();

    fireEvent.click(screen.getByRole("button", { name: "同步 Following" }));

    await waitFor(() => {
      expect(messages).toContainEqual({ type: "SYNC_START", forceReload: false });
    });
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

    fireEvent.click(screen.getByRole("button", { name: "开始清理（预览）" }));
    expect(screen.getByText(/无法保证零风险/)).toBeInTheDocument();
    expect(screen.getByText(/档位 安全/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认并开始" }));
    await waitFor(() => {
      expect(messages).toContainEqual({ type: "QUEUE_START", userIds: ["2"] });
    });
  });

  it("starts once a sync round ended at its target count", async () => {
    installChrome(
      signedInState({
        syncMeta: { ...createDefaultState().syncMeta, status: "paused", pauseReason: "budget" },
      }),
    );
    await renderReadyApp();
    fireEvent.click(screen.getByRole("button", { name: "清理" }));

    expect(screen.getByRole("button", { name: "开始清理（预览）" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "开始清理（预览）" }));
    fireEvent.click(screen.getByRole("button", { name: "确认并开始" }));

    await waitFor(() => {
      expect(messages).toContainEqual({ type: "QUEUE_START", userIds: ["2", "3"] });
    });
  });

  it("keeps start closed while a hidden pause can resume the scroll round", async () => {
    installChrome(
      signedInState({
        syncMeta: { ...createDefaultState().syncMeta, status: "paused", pauseReason: "hidden" },
      }),
    );
    await renderReadyApp();
    fireEvent.click(screen.getByRole("button", { name: "清理" }));

    expect(screen.getByRole("button", { name: "开始清理（预览）" })).toBeDisabled();
    expect(screen.getByText(/请先停止同步再取关/)).toBeInTheDocument();
  });

  it("explains a refused start instead of doing nothing", async () => {
    installChrome(signedInState());
    commandReplies.set("QUEUE_START", { ok: true, result: { ok: false, reason: "sync-running" } });
    await renderReadyApp();
    fireEvent.click(screen.getByRole("button", { name: "清理" }));
    fireEvent.click(screen.getByRole("button", { name: "开始清理（预览）" }));
    fireEvent.click(screen.getByRole("button", { name: "确认并开始" }));

    await waitFor(() => {
      expect(screen.getByText(/同步仍在进行/)).toBeInTheDocument();
    });
  });

  it("acknowledges a successful start with a countdown", async () => {
    installChrome(signedInState());
    await renderReadyApp();
    fireEvent.click(screen.getByRole("button", { name: "清理" }));
    fireEvent.click(screen.getByRole("button", { name: "开始清理（预览）" }));
    fireEvent.click(screen.getByRole("button", { name: "确认并开始" }));

    await waitFor(() => {
      expect(screen.getByText(/队列已启动/)).toBeInTheDocument();
      expect(screen.getByText(/将在 2–10 秒内执行第一次取关/)).toBeInTheDocument();
    });
  });

  it("reports a worker that never answered", async () => {
    installChrome(signedInState());
    commandReplies.set("QUEUE_START", undefined);
    await renderReadyApp();
    fireEvent.click(screen.getByRole("button", { name: "清理" }));
    fireEvent.click(screen.getByRole("button", { name: "开始清理（预览）" }));
    fireEvent.click(screen.getByRole("button", { name: "确认并开始" }));

    await waitFor(() => {
      expect(screen.getByText(/扩展后台没有响应/)).toBeInTheDocument();
    });
  });

  it("ends a paused sync round from the insight view", async () => {
    installChrome(
      signedInState({
        syncMeta: { ...createDefaultState().syncMeta, status: "paused", pauseReason: "hidden" },
      }),
    );
    await renderReadyApp();
    fireEvent.click(screen.getByRole("button", { name: "结束本轮" }));

    await waitFor(() => {
      expect(messages).toContainEqual({ type: "SYNC_STOP" });
    });
  });

  it("disables start during cooldown and offers manual dismiss", async () => {
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
    expect(screen.getByRole("button", { name: "开始清理（预览）" })).toBeDisabled();
    expect(screen.getByText(/熔断中/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "刷新登录状态" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "解除熔断" })).toBeInTheDocument();
  });

  it("requests cooldown dismiss from the cooldown banner", async () => {
    const until = Date.now() + 60 * 60 * 1000;
    installChrome(
      signedInState({
        unfollowQueue: {
          ...createDefaultState().unfollowQueue,
          status: "cooldown",
          cooldownUntil: until,
          pauseReason: "auth-required",
        },
      }),
    );
    await renderReadyApp();
    fireEvent.click(screen.getByRole("button", { name: "清理" }));
    fireEvent.click(screen.getByRole("button", { name: "解除熔断" }));

    await waitFor(() => {
      expect(messages).toContainEqual({ type: "QUEUE_DISMISS_COOLDOWN" });
    });
  });

  it("requests auth refresh from the cooldown banner", async () => {
    const until = Date.now() + 60 * 60 * 1000;
    installChrome(
      signedInState({
        unfollowQueue: {
          ...createDefaultState().unfollowQueue,
          status: "cooldown",
          cooldownUntil: until,
          pauseReason: "auth-required",
        },
      }),
    );
    await renderReadyApp();
    fireEvent.click(screen.getByRole("button", { name: "清理" }));
    fireEvent.click(screen.getByRole("button", { name: "刷新登录状态" }));

    await waitFor(() => {
      expect(messages).toContainEqual({ type: "AUTH_REFRESH" });
    });
  });

  it("explains an hourly quota hold instead of a raw second countdown", async () => {
    const now = Date.now();
    installChrome(
      signedInState({
        unfollowQueue: {
          ...createDefaultState().unfollowQueue,
          status: "running",
          sessionStartedAt: now,
          ownerUserId: "9",
          nextAt: now + 2_928_000,
          actionTimestamps: [now - 5_000, now - 4_000, now - 3_000, now - 2_000, now - 1_000],
          items: [
            { userId: "2", handle: "alice", status: "pending", attempts: 0, lastCode: null },
            { userId: "3", handle: "bob", status: "pending", attempts: 0, lastCode: null },
          ],
        },
      }),
    );
    await renderReadyApp();
    fireEvent.click(screen.getByRole("button", { name: "清理" }));

    expect(screen.getByText("等待每小时上限")).toBeInTheDocument();
    expect(screen.getByText(/已达每小时上限（5\/5）/)).toBeInTheDocument();
    expect(screen.getByText(/约 49 分钟后自动继续/)).toBeInTheDocument();
    expect(screen.getByText(/剩余 2 个 · 本小时 5\/5 · 本次会话 0\/10/)).toBeInTheDocument();
    expect(screen.getAllByText(/可在「设置」中切换安全档位/).length).toBeGreaterThan(0);
  });

  it("whitelists a candidate from the cleanup list", async () => {
    installChrome(signedInState());
    await renderReadyApp();
    fireEvent.click(screen.getByRole("button", { name: "清理" }));
    fireEvent.click(screen.getAllByRole("button", { name: "白名单" })[0]!);
    expect(messages.some((message) => message.type === "WHITELIST_UPDATE")).toBe(true);
  });

  it("removes a candidate from the cleanup list", async () => {
    installChrome(signedInState());
    await renderReadyApp();
    fireEvent.click(screen.getByRole("button", { name: "清理" }));
    fireEvent.click(screen.getAllByRole("button", { name: "删除 @alice" })[0]!);
    expect(messages).toContainEqual({ type: "FOLLOWING_REMOVE", userIds: ["2"] });
  });

  it("removes a whitelist entry from settings", async () => {
    installChrome(
      signedInState({ whitelist: [{ handle: "alice" }, { userId: "3", handle: "bob" }] }),
    );
    await renderReadyApp();
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    fireEvent.click(screen.getByRole("button", { name: "移除 @alice" }));

    const update = messages.find((message) => message.type === "WHITELIST_UPDATE");
    expect(update).toEqual({
      type: "WHITELIST_UPDATE",
      entries: [{ userId: "3", handle: "bob" }],
    });
  });

  it("shows quota copy for the selected safety preset", async () => {
    installChrome(signedInState());
    await renderReadyApp();
    fireEvent.click(screen.getByRole("button", { name: "设置" }));

    expect(screen.getByText(/间隔 2–10 秒；每小时 5，每天 20，每会话 10/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: "均衡" }));
    expect(screen.getByText(/间隔 2–10 秒；每小时 8，每天 30，每会话 15/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: "自定义" }));
    expect(
      screen.getByText(/间隔不低于 2 秒；每小时 ≤12，每天 ≤40，每会话 ≤20/),
    ).toBeInTheDocument();
  });

  it("shows sync target count in settings with default and helper copy", async () => {
    installChrome(signedInState());
    await renderReadyApp();
    fireEvent.click(screen.getByRole("button", { name: "设置" }));

    expect(screen.getByRole("spinbutton", { name: "每轮同步人数" })).toHaveValue(1_000);
    expect(screen.getByText("100–5000，默认 1000")).toBeInTheDocument();
  });

  it("saves sync target count through SETTINGS_UPDATE", async () => {
    installChrome(signedInState());
    await renderReadyApp();
    fireEvent.click(screen.getByRole("button", { name: "设置" }));

    const input = screen.getByRole("spinbutton", { name: "每轮同步人数" });
    fireEvent.change(input, {
      target: { value: "2500" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));

    expect(messages).toContainEqual({
      type: "SETTINGS_UPDATE",
      settings: expect.objectContaining({ syncTargetCount: 2_500 }),
    });
    expect(input).toHaveValue(2_500);
  });

  it("keeps cleared sync target count blank until save", async () => {
    installChrome(signedInState());
    await renderReadyApp();
    fireEvent.click(screen.getByRole("button", { name: "设置" }));

    const input = screen.getByRole("spinbutton", { name: "每轮同步人数" });
    fireEvent.change(input, { target: { value: "" } });
    expect(input).toHaveValue(null);

    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));

    expect(messages).toContainEqual({
      type: "SETTINGS_UPDATE",
      settings: expect.objectContaining({ syncTargetCount: 1_000 }),
    });
    expect(input).toHaveValue(1_000);
  });

  it("clamps out-of-range sync target count on save", async () => {
    installChrome(signedInState());
    await renderReadyApp();
    fireEvent.click(screen.getByRole("button", { name: "设置" }));

    const input = screen.getByRole("spinbutton", { name: "每轮同步人数" });
    fireEvent.change(input, {
      target: { value: "99999" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));

    expect(messages).toContainEqual({
      type: "SETTINGS_UPDATE",
      settings: expect.objectContaining({ syncTargetCount: 5_000 }),
    });
    expect(input).toHaveValue(5_000);
  });

  it("persists scan strategy toggles from settings", async () => {
    installChrome(signedInState());
    await renderReadyApp();
    fireEvent.click(screen.getByRole("button", { name: "设置" }));

    fireEvent.click(screen.getByRole("checkbox", { name: /对方非蓝标/ }));
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));

    expect(messages).toContainEqual({
      type: "SETTINGS_UPDATE",
      settings: expect.objectContaining({
        scanStrategies: expect.objectContaining({ nonBlueVerified: true }),
      }),
    });
  });

  it("sorts cleanup candidates by the default strategy cascade", async () => {
    installChrome(mixedStrategyState());
    await renderReadyApp();
    fireEvent.click(screen.getByRole("button", { name: "清理" }));

    expect(listedHandles()).toEqual(["选择 @ghosted", "选择 @plain", "选择 @locked"]);
    expect(screen.getByRole("combobox", { name: "排序" })).toHaveValue("priority");
    expect(screen.getByRole("option", { name: "策略优先级" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "未回关" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "非蓝标" })).toBeInTheDocument();
  });

  it("omits disabled strategies from the sort picker", async () => {
    installChrome(signedInState());
    await renderReadyApp();
    fireEvent.click(screen.getByRole("button", { name: "清理" }));

    expect(screen.getByRole("option", { name: "策略优先级" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "未回关" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "非蓝标" })).not.toBeInTheDocument();
  });

  it("reorders the list and queue start ids when a strategy is chosen", async () => {
    installChrome(mixedStrategyState());
    await renderReadyApp();
    fireEvent.click(screen.getByRole("button", { name: "清理" }));

    fireEvent.change(screen.getByRole("combobox", { name: "排序" }), {
      target: { value: "non-blue-verified" },
    });

    expect(listedHandles()).toEqual(["选择 @plain", "选择 @ghosted", "选择 @locked"]);

    fireEvent.click(screen.getByRole("button", { name: "开始清理（预览）" }));
    fireEvent.click(screen.getByRole("button", { name: "确认并开始" }));

    await waitFor(() => {
      expect(messages).toContainEqual({ type: "QUEUE_START", userIds: ["nb", "nf", "pr"] });
    });
  });
});
