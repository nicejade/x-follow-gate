import { useEffect, useMemo, useState } from "react";

import { ConfirmQueueDialog } from "@/sidepanel/components/ConfirmQueueDialog";
import { StatusBanner } from "@/sidepanel/components/StatusBanner";
import type { SendCommand } from "@/sidepanel/hooks/useExtensionState";
import { formatEta, intervalBand, PRESET_LABELS } from "@/sidepanel/lib/metrics";
import { describeOutcome } from "@/sidepanel/lib/outcome";
import { selectCandidates } from "@/shared/rules";
import { COOLDOWN_MS, countWithinWindow, HOUR_MS, isSyncBlockingQueue } from "@/shared/safety";
import type { ExtensionState, FollowingUser, SyncMeta } from "@/shared/types";

interface CleanupViewProps {
  state: ExtensionState;
  send: SendCommand;
  now?: number;
}

export function CleanupView({ state, send, now = Date.now() }: CleanupViewProps) {
  const candidates = useMemo(
    () => selectCandidates(Object.values(state.following), state.whitelist),
    [state.following, state.whitelist],
  );
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(candidates.map((user) => user.userId)),
  );
  const [confirming, setConfirming] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  useEffect(() => {
    setSelected(new Set(candidates.map((user) => user.userId)));
  }, [candidates]);

  const queue = state.unfollowQueue;
  const running = queue.status === "running";
  // Mirrors the worker, which reads the window rather than the status: a
  // breaker whose window already closed must not keep Start disabled.
  const cooling = (queue.cooldownUntil ?? 0) > now;
  const syncBlocking = isSyncBlockingQueue(state.syncMeta);
  const signedIn = state.session.account !== null;
  const startDisabled = selected.size === 0 || syncBlocking || !signedIn || cooling || running;

  const remaining = queue.items.filter(
    (item) => item.status === "pending" || item.status === "in-flight",
  );
  const current = queue.items.find((item) => item.status === "in-flight") ?? remaining[0];
  const countdown =
    queue.nextAt !== null && queue.nextAt > now ? Math.ceil((queue.nextAt - now) / 1000) : 0;
  const hourCount = countWithinWindow(queue.actionTimestamps, now, HOUR_MS);
  const sessionCount = queue.actionTimestamps.filter(
    (stamp) => stamp >= (queue.sessionStartedAt ?? 0),
  ).length;

  async function startQueue(userIds: string[]) {
    setStartError(null);
    setStartError(describeOutcome(await send({ type: "QUEUE_START", userIds }), START_BLOCK_COPY));
  }

  return (
    <section className="space-y-4">
      <p className="text-sm text-muted">未回关 · 已排除白名单</p>

      {cooling ? (
        <StatusBanner tone="danger">
          {`熔断中：${pauseCopy(queue.pauseReason)}。将于 ${new Date(queue.cooldownUntil ?? now + COOLDOWN_MS).toLocaleString()} 后可再次开始，不会忽略冷却。`}
        </StatusBanner>
      ) : null}
      {syncBlocking ? <StatusBanner>{syncBlockCopy(state.syncMeta)}</StatusBanner> : null}
      {startError !== null ? <StatusBanner tone="danger">{startError}</StatusBanner> : null}

      {running || queue.status === "paused" ? (
        <div className="rounded-[var(--radius-panel)] bg-surface px-3 py-3 text-sm">
          <p>当前：{current ? `@${current.handle}` : "等待中"}</p>
          <p className="mt-1 text-muted">
            剩余 {remaining.length} · 下次 {countdown}s · 时 {hourCount}/{state.settings.hourlyCap}{" "}
            · 会话 {sessionCount}/{state.settings.sessionCap}
          </p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              className="min-h-11 flex-1 rounded-[var(--radius-panel)] border border-border"
              onClick={() => send({ type: "QUEUE_PAUSE", reason: "user" })}
            >
              暂停
            </button>
            <button
              type="button"
              className="min-h-11 flex-1 rounded-[var(--radius-panel)] border border-danger text-danger"
              onClick={() => send({ type: "QUEUE_STOP" })}
            >
              停止
            </button>
          </div>
        </div>
      ) : null}

      <ul className="divide-y divide-border overflow-y-auto">
        {candidates.map((user) => (
          <CandidateRow
            key={user.userId}
            user={user}
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
          />
        ))}
      </ul>

      <button
        type="button"
        className="min-h-11 w-full rounded-[var(--radius-panel)] bg-accent text-sm font-medium text-bg disabled:opacity-40"
        disabled={startDisabled}
        onClick={() => setConfirming(true)}
      >
        预览并开始
      </button>

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
};

function syncBlockCopy(syncMeta: SyncMeta): string {
  return syncMeta.pauseReason === "hidden"
    ? "同步已因标签页隐藏暂停，回到该标签后会自动继续；请先停止同步再取关。"
    : "同步进行中，取关已禁用。";
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
  checked,
  onToggle,
  onWhitelist,
}: {
  user: FollowingUser;
  checked: boolean;
  onToggle: () => void;
  onWhitelist: () => void;
}) {
  return (
    <li className="flex min-h-11 items-center gap-3 py-2">
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        aria-label={`选择 @${user.handle}`}
      />
      {user.avatarUrl ? (
        <img src={user.avatarUrl} alt="" className="h-8 w-8 rounded-full" />
      ) : (
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-surface-raised text-xs">
          {user.name.slice(0, 1)}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm">{user.name}</p>
        <p className="truncate text-xs text-muted">@{user.handle} · 未回关</p>
      </div>
      <button type="button" className="min-h-11 px-2 text-xs text-muted" onClick={onWhitelist}>
        白名单
      </button>
    </li>
  );
}
