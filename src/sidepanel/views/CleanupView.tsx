import { useEffect, useMemo, useState } from "react";

import { ConfirmQueueDialog } from "@/sidepanel/components/ConfirmQueueDialog";
import { StatusBanner } from "@/sidepanel/components/StatusBanner";
import type { SendCommand } from "@/sidepanel/hooks/useExtensionState";
import {
  describeQueueProgress,
  enabledStrategyCount,
  formatEta,
  intervalBand,
  PRESET_LABELS,
} from "@/sidepanel/lib/metrics";
import { describeOutcome, describeQueueStart } from "@/sidepanel/lib/outcome";
import { matchReasons, SCAN_STRATEGY_LABELS, selectCandidates } from "@/shared/rules";
import { canRunNext, COOLDOWN_MS, countWithinWindow, HOUR_MS, isSyncBlockingQueue } from "@/shared/safety";
import type { ExtensionState, FollowingUser, QueuePauseReason, SyncMeta } from "@/shared/types";

interface CleanupViewProps {
  state: ExtensionState;
  send: SendCommand;
  now?: number;
}

export function CleanupView({ state, send, now: nowOverride }: CleanupViewProps) {
  const [now, setNow] = useState(() => nowOverride ?? Date.now());
  const candidates = useMemo(
    () =>
      selectCandidates(
        Object.values(state.following),
        state.whitelist,
        state.settings.scanStrategies,
      ),
    [state.following, state.whitelist, state.settings.scanStrategies],
  );
  const enabledCount = enabledStrategyCount(state.settings.scanStrategies);
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(candidates.map((user) => user.userId)),
  );
  const [confirming, setConfirming] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [startSuccess, setStartSuccess] = useState<string | null>(null);
  const [refreshMessage, setRefreshMessage] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [dismissMessage, setDismissMessage] = useState<string | null>(null);
  const [dismissing, setDismissing] = useState(false);

  useEffect(() => {
    setSelected(new Set(candidates.map((user) => user.userId)));
  }, [candidates]);

  const queue = state.unfollowQueue;
  const queueLive = queue.status === "running" || queue.status === "paused";
  const running = queue.status === "running";
  const cooling = (queue.cooldownUntil ?? 0) > now;
  const syncBlocking = isSyncBlockingQueue(state.syncMeta);
  const signedIn = state.session.account !== null;
  const startDisabled = selected.size === 0 || syncBlocking || !signedIn || cooling || running;

  useEffect(() => {
    if (nowOverride !== undefined) {
      return;
    }

    if (!queueLive && !cooling) {
      return;
    }

    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 1_000);

    return () => {
      window.clearInterval(timer);
    };
  }, [cooling, nowOverride, queueLive]);

  const remaining = queue.items.filter(
    (item) => item.status === "pending" || item.status === "in-flight",
  );
  const current = queue.items.find((item) => item.status === "in-flight") ?? remaining[0];
  const inFlight = current?.status === "in-flight";
  const countdown =
    !inFlight && queue.nextAt !== null && queue.nextAt > now
      ? Math.ceil((queue.nextAt - now) / 1000)
      : 0;
  const hourCount = countWithinWindow(queue.actionTimestamps, now, HOUR_MS);
  const sessionCount = queue.actionTimestamps.filter(
    (stamp) => stamp >= (queue.sessionStartedAt ?? 0),
  ).length;
  const hold = canRunNext(queue, now, state.settings);
  const progress = describeQueueProgress({
    inFlight,
    paused: queue.status === "paused",
    reason: hold.reason,
    countdownSec: countdown,
    remaining: remaining.length,
    hourCount,
    hourlyCap: state.settings.hourlyCap,
    sessionCount,
    sessionCap: state.settings.sessionCap,
  });

  async function dismissCooldown() {
    setDismissMessage(null);
    setDismissing(true);
    const outcome = await send({ type: "QUEUE_DISMISS_COOLDOWN" });
    setDismissing(false);
    setDismissMessage(describeDismissCooldown(outcome));
  }

  async function refreshAuthStatus() {
    setRefreshMessage(null);
    setRefreshing(true);
    const outcome = await send({ type: "AUTH_REFRESH" });
    setRefreshing(false);
    setRefreshMessage(describeAuthRefresh(outcome));
  }

  async function startQueue(userIds: string[]) {
    setStartError(null);
    setStartSuccess(null);
    const feedback = describeQueueStart(
      await send({ type: "QUEUE_START", userIds }),
      START_BLOCK_COPY,
    );
    setStartError(feedback.error);
    setStartSuccess(feedback.success);
  }

  return (
    <section className="space-y-4">
      <p className="text-sm text-muted">已启用 {enabledCount} 条策略 · 已排除白名单</p>

      {cooling ? (
        <StatusBanner tone="danger">
          <div className="space-y-3">
            <p>{`熔断中：${pauseCopy(queue.pauseReason)}。将于 ${new Date(queue.cooldownUntil ?? now + COOLDOWN_MS).toLocaleString()} 后可自动恢复，或由你手动解除。`}</p>
            <div className="flex gap-2">
              <button
                type="button"
                className="min-h-11 flex-1 rounded-[var(--radius-panel)] border border-danger/40 text-sm disabled:opacity-40"
                disabled={refreshing || dismissing}
                onClick={() => void refreshAuthStatus()}
              >
                {refreshing ? "刷新中…" : "刷新登录状态"}
              </button>
              <button
                type="button"
                className="min-h-11 flex-1 rounded-[var(--radius-panel)] border border-danger text-sm text-danger disabled:opacity-40"
                disabled={refreshing || dismissing}
                onClick={() => void dismissCooldown()}
              >
                {dismissing ? "解除中…" : "解除熔断"}
              </button>
            </div>
          </div>
        </StatusBanner>
      ) : null}
      {refreshMessage !== null ? <StatusBanner>{refreshMessage}</StatusBanner> : null}
      {dismissMessage !== null ? (
        <StatusBanner tone={dismissMessage.includes("已解除") ? "success" : "danger"}>
          {dismissMessage}
        </StatusBanner>
      ) : null}
      {syncBlocking ? <StatusBanner>{syncBlockCopy(state.syncMeta)}</StatusBanner> : null}
      {startSuccess !== null ? <StatusBanner tone="success">{startSuccess}</StatusBanner> : null}
      {startError !== null ? <StatusBanner tone="danger">{startError}</StatusBanner> : null}

      {queueLive ? (
        <div className="rounded-[var(--radius-panel)] bg-surface px-3 py-3 text-sm">
          <p className="font-medium">{progress.title}</p>
          <p className="mt-1">
            当前：{current ? `@${current.handle}` : "等待中"}
            {queue.status === "paused" && queue.pauseReason !== null
              ? ` · ${queuePauseCopy(queue.pauseReason)}`
              : null}
          </p>
          <p className="mt-1 text-muted">{progress.wait}</p>
          <p className="mt-1 text-muted">{progress.stats}</p>
          <p className="mt-2 text-xs text-muted">{progress.hint}</p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              className="min-h-11 flex-1 rounded-[var(--radius-panel)] border border-border"
              onClick={() => void send({ type: "QUEUE_PAUSE", reason: "user" })}
            >
              暂停
            </button>
            <button
              type="button"
              className="min-h-11 flex-1 rounded-[var(--radius-panel)] border border-danger text-danger"
              onClick={() => void send({ type: "QUEUE_STOP" })}
            >
              停止
            </button>
          </div>
        </div>
      ) : null}

      <button
        type="button"
        className="min-h-11 w-full rounded-[var(--radius-panel)] bg-accent text-sm font-medium text-bg disabled:opacity-40"
        disabled={startDisabled}
        onClick={() => setConfirming(true)}
      >
        开始清理（预览）
      </button>

      <ul className="divide-y divide-border overflow-y-auto">
        {candidates.map((user) => (
          <CandidateRow
            key={user.userId}
            user={user}
            reasons={matchReasons(user, state.settings.scanStrategies)}
            checked={selected.has(user.userId)}
            onToggle={() => {
              setSelected((currentSet) => {
                const next = new Set(currentSet);
                if (next.has(user.userId)) {
                  next.delete(user.userId);
                } else {
                  next.add(user.userId);
                }
                return next;
              });
            }}
            onWhitelist={() =>
              send({
                type: "WHITELIST_UPDATE",
                entries: [...state.whitelist, { userId: user.userId, handle: user.handle }],
              })
            }
            onRemove={() => send({ type: "FOLLOWING_REMOVE", userIds: [user.userId] })}
          />
        ))}
      </ul>

      {confirming ? (
        <ConfirmQueueDialog
          count={selected.size}
          preset={PRESET_LABELS[state.settings.preset]}
          interval={intervalBand(state)}
          eta={formatEta(
            selected.size,
            state.settings.intervalMinSec,
            state.settings.intervalMaxSec,
          )}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            void startQueue([...selected]);
          }}
        />
      ) : null}
    </section>
  );
}

const START_BLOCK_COPY: Record<string, string> = {
  "auth-required": "未读取到 X 登录状态，请在 x.com 登录后重试。",
  "queue-active": "已有取关任务在进行中。",
  cooldown: "仍在安全冷却窗口内，暂时无法开始。",
  "sync-running": "同步仍在进行，请先在洞察页停止本轮同步。",
  "no-candidates": "所选账号已不在候选中，可能已回关或被加入白名单。",
  "missing-tab": "无法打开 x.com 标签页，请允许扩展打开标签页后重试。",
};

function queuePauseCopy(reason: QueuePauseReason): string {
  switch (reason) {
    case "user":
      return "已手动暂停";
    case "session-cap":
      return "已达本次会话上限";
    case "hourly-cap":
      return "已达每小时上限";
    case "daily-cap":
      return "已达每日上限";
    case "outside-active-hours":
      return "不在允许时段内";
    case "missing-tab":
      return "缺少 x.com 标签页";
    case "auth-required":
      return "需要重新登录";
    case "account-mismatch":
      return "账号已切换";
    case "rate-limited":
      return "触发限流";
    case "consecutive-failures":
      return "连续失败";
    default:
      return reason;
  }
}

function syncBlockCopy(syncMeta: SyncMeta): string {
  return syncMeta.pauseReason === "hidden"
    ? "同步已因标签页隐藏暂停，回到该标签后会自动继续；请先停止同步再取关。"
    : "同步进行中，取关已禁用。";
}

const AUTH_REFRESH_COPY: Record<string, string> = {
  "missing-tab": "未找到 x.com 标签页，请先打开并登录后重试。",
};

const DISMISS_COOLDOWN_COPY: Record<string, string> = {
  "not-cooling": "当前不在熔断冷却中。",
};

function describeDismissCooldown(outcome: Awaited<ReturnType<SendCommand>>): string {
  const error = describeOutcome(outcome, DISMISS_COOLDOWN_COPY);
  if (error !== null) {
    return error;
  }

  if (!outcome.ok) {
    return "解除失败，请稍后重试。";
  }

  const result = outcome.result;
  if (typeof result === "object" && result !== null && (result as { ok?: unknown }).ok === true) {
    return "熔断已解除，可以重新开始取关。";
  }

  return "解除失败，请稍后重试。";
}

function describeAuthRefresh(outcome: Awaited<ReturnType<SendCommand>>): string {
  const error = describeOutcome(outcome, AUTH_REFRESH_COPY);
  if (error !== null) {
    return error;
  }

  if (!outcome.ok) {
    return "已请求刷新，请稍候查看登录状态。";
  }

  const result = outcome.result;
  if (typeof result !== "object" || result === null) {
    return "已请求刷新，请稍候查看登录状态。";
  }

  const { ok, delivered } = result as { ok?: unknown; delivered?: unknown };
  if (ok === true && delivered === false) {
    return "已请求刷新，x.com 页面加载完成后会自动更新登录状态。";
  }

  return "已请求刷新，请稍候查看登录状态。";
}

function pauseCopy(reason: ExtensionState["unfollowQueue"]["pauseReason"]): string {
  switch (reason) {
    case "rate-limited":
      return "触发限流";
    case "auth-required":
      return "需要重新登录或验证";
    case "consecutive-failures":
      return "连续失败";
    default:
      return reason ?? "安全冷却";
  }
}

function CandidateRow({
  user,
  reasons,
  checked,
  onToggle,
  onWhitelist,
  onRemove,
}: {
  user: FollowingUser;
  reasons: ReturnType<typeof matchReasons>;
  checked: boolean;
  onToggle: () => void;
  onWhitelist: () => void;
  onRemove: () => void;
}) {
  return (
    <li className="flex items-center gap-2.5 py-1.5">
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        aria-label={`选择 @${user.handle}`}
        className="shrink-0"
      />
      {user.avatarUrl ? (
        <img src={user.avatarUrl} alt="" className="h-8 w-8 shrink-0 rounded-full" />
      ) : (
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-raised text-xs">
          {user.name.slice(0, 1)}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm leading-tight">{user.name}</p>
        <p className="truncate text-xs leading-tight text-muted">
          @{user.handle}
          {reasons.length > 0
            ? ` · ${reasons.map((id) => SCAN_STRATEGY_LABELS[id]).join(" · ")}`
            : ""}
        </p>
      </div>
      <div className="flex shrink-0 flex-col gap-0">
        <button
          type="button"
          className="cursor-pointer rounded-md px-2 py-0.5 text-xs text-muted transition-colors hover:bg-surface-raised hover:text-text"
          onClick={onWhitelist}
        >
          白名单
        </button>
        <button
          type="button"
          aria-label={`删除 @${user.handle}`}
          className="cursor-pointer rounded-md px-2 py-0.5 text-xs text-muted transition-colors hover:bg-danger hover:text-white"
          onClick={onRemove}
        >
          删除
        </button>
      </div>
    </li>
  );
}
