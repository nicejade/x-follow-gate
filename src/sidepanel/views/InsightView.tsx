import { useState } from "react";

import { StatusBanner } from "@/sidepanel/components/StatusBanner";
import type { SendCommand } from "@/sidepanel/hooks/useExtensionState";
import { cleanupCandidateCount, formatPercent, insightMetrics } from "@/sidepanel/lib/metrics";
import { describeOutcome } from "@/sidepanel/lib/outcome";
import type { ExtensionState } from "@/shared/types";

interface InsightViewProps {
  state: ExtensionState;
  send: SendCommand;
}

const SYNC_BLOCK_COPY: Record<string, string> = {
  "queue-running": "取关队列仍在进行或冷却中，暂时无法同步。",
  auth: "未读取到 X 登录状态，请在 x.com 登录后重试。",
  "missing-tab": "无法打开关注列表标签页，请手动打开后重试。",
};

export function InsightView({ state, send }: InsightViewProps) {
  const [syncError, setSyncError] = useState<string | null>(null);
  const metrics = insightMetrics(state);
  const syncing = state.syncMeta.status === "running";
  // A paused round still owns the tab, so it needs an explicit way to end.
  const syncActive = syncing || state.syncMeta.status === "paused";
  const queueBusy =
    state.unfollowQueue.status === "running" || state.unfollowQueue.status === "cooldown";
  const signedIn = state.session.account !== null;

  async function startSync() {
    setSyncError(null);
    const outcome = await send({ type: "SYNC_START" });
    setSyncError(describeOutcome(outcome, SYNC_BLOCK_COPY));
  }

  return (
    <section className="space-y-4">
      {!signedIn ? (
        <StatusBanner tone="danger">请先在 x.com 登录，扩展会复用当前会话。</StatusBanner>
      ) : null}
      {syncError !== null ? <StatusBanner tone="danger">{syncError}</StatusBanner> : null}
      {queueBusy ? <StatusBanner>取关队列进行中，同步已暂停以免并行请求。</StatusBanner> : null}
      {state.syncMeta.pauseReason === "hidden" ? (
        <StatusBanner>关注列表标签页已隐藏超过 45 秒，滚动已暂停。请保持该标签在前。</StatusBanner>
      ) : null}
      {state.syncMeta.pauseReason === "budget" ? (
        <StatusBanner>本轮同步已达到人数上限，可继续发起下一轮。</StatusBanner>
      ) : null}
      {state.syncMeta.pauseReason === "stalled" || state.syncMeta.status === "completed" ? (
        <StatusBanner>
          {state.syncMeta.likelyComplete
            ? "列表可能已到底，同步结束。"
            : "连续多步没有新账号，本轮已结束。"}
        </StatusBanner>
      ) : null}

      <div className="grid grid-cols-2 gap-2">
        <Metric label="已同步" value={String(metrics.synced)} />
        <Metric label="待清理候选" value={String(cleanupCandidateCount(state))} />
        <Metric label="互关率" value={formatPercent(metrics.mutualRate)} />
        <Metric label="关系未知" value={String(metrics.unknown)} />
      </div>

      <p className="text-sm text-muted">将打开关注列表并渐进滚动采集。请保持关注列表标签页在前。</p>
      {syncing ? (
        <p className="text-sm text-muted">
          正在渐进滚动采集 · 已发现 {state.syncMeta.discoveredCount} 人。
        </p>
      ) : null}

      <div className="flex gap-2">
        <button
          type="button"
          className="min-h-11 flex-1 rounded-[var(--radius-panel)] bg-accent px-4 text-sm font-medium text-bg disabled:opacity-40"
          disabled={!signedIn || queueBusy || syncing}
          onClick={() => void startSync()}
        >
          同步 Following
        </button>
        {syncing ? (
          <button
            type="button"
            className="min-h-11 rounded-[var(--radius-panel)] border border-border px-4 text-sm"
            onClick={() => void send({ type: "SYNC_PAUSE", reason: "user" })}
          >
            暂停
          </button>
        ) : null}
        {syncActive ? (
          <button
            type="button"
            className="min-h-11 rounded-[var(--radius-panel)] border border-border px-4 text-sm"
            onClick={() => void send({ type: "SYNC_STOP" })}
          >
            结束本轮
          </button>
        ) : null}
      </div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[var(--radius-panel)] bg-surface px-3 py-3">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold tracking-tight">{value}</p>
    </div>
  );
}
