import { selectCandidates } from "@/shared/rules";
import type { ExtensionState, QuotaBlockReason, SafetyPreset } from "@/shared/types";
import { PRESET_LIMITS } from "@/shared/safety";

export type PanelTab = "insight" | "cleanup" | "settings";

export const TAB_LABELS: Record<PanelTab, string> = {
  insight: "洞察",
  cleanup: "清理",
  settings: "设置",
};

export const PRESET_LABELS: Record<SafetyPreset, string> = {
  safe: "安全",
  balanced: "均衡",
  custom: "自定义",
};

export function startOfLocalDay(now: number): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function todayUnfollowCount(state: ExtensionState, now: number): number {
  const start = startOfLocalDay(now);
  return state.unfollowQueue.actionTimestamps.filter((stamp) => stamp >= start).length;
}

export function cleanupCandidateCount(state: ExtensionState): number {
  return selectCandidates(
    Object.values(state.following),
    state.whitelist,
    state.settings.scanStrategies,
  ).length;
}

export function enabledStrategyCount(
  strategies: ExtensionState["settings"]["scanStrategies"],
): number {
  return Object.values(strategies).filter(Boolean).length;
}

export function insightMetrics(state: ExtensionState) {
  const users = Object.values(state.following);
  let mutual = 0;
  let nonMutual = 0;
  let unknown = 0;

  for (const user of users) {
    if (user.followedBy === true) {
      mutual += 1;
    } else if (user.followedBy === false) {
      nonMutual += 1;
    } else {
      unknown += 1;
    }
  }

  const known = mutual + nonMutual;

  return {
    synced: users.length,
    mutual,
    nonMutual,
    unknown,
    mutualRate: known === 0 ? null : mutual / known,
  };
}

export function formatPercent(value: number | null): string {
  if (value === null) {
    return "—";
  }

  return `${Math.round(value * 100)}%`;
}

export function formatEta(count: number, intervalMinSec: number, intervalMaxSec: number): string {
  if (count <= 0) {
    return "0 分钟";
  }

  const mid = (intervalMinSec + intervalMaxSec) / 2;
  const minutes = Math.max(1, Math.round((count * mid) / 60));
  return `约 ${minutes} 分钟`;
}

export function intervalBand(state: ExtensionState): string {
  const { intervalMinSec, intervalMaxSec, preset } = state.settings;
  if (preset !== "custom") {
    const limits = PRESET_LIMITS[preset];
    return `${limits.intervalMinSec}–${limits.intervalMaxSec} 秒`;
  }

  return `${intervalMinSec}–${intervalMaxSec} 秒`;
}

/** Human duration for a queue hold. Seconds stay precise; longer waits round to minutes. */
export function formatWaitDuration(seconds: number): string {
  if (seconds <= 0) {
    return "即将执行";
  }

  if (seconds < 60) {
    return `${seconds} 秒`;
  }

  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) {
    return `约 ${minutes} 分钟`;
  }

  const hours = Math.max(1, Math.round(minutes / 60));
  return `约 ${hours} 小时`;
}

export interface QueueProgressInput {
  inFlight: boolean;
  paused?: boolean;
  reason: QuotaBlockReason | null;
  countdownSec: number;
  remaining: number;
  hourCount: number;
  hourlyCap: number;
  sessionCount: number;
  sessionCap: number;
}

export interface QueueProgressCopy {
  title: string;
  wait: string;
  stats: string;
  hint: string;
}

const SETTINGS_HINT = "每小时、每天、每会话上限可在「设置」中切换安全档位。";

export function describeQueueProgress(input: QueueProgressInput): QueueProgressCopy {
  const stats = `剩余 ${input.remaining} 个 · 本小时 ${input.hourCount}/${input.hourlyCap} · 本次会话 ${input.sessionCount}/${input.sessionCap}`;
  const hint = `打开目标主页后停留 2–10 秒再取关。${SETTINGS_HINT}`;

  if (input.paused === true) {
    return { title: "队列已暂停", wait: "已暂停，不会自动继续。", stats, hint };
  }

  if (input.inFlight) {
    return { title: "取关进行中", wait: "正在当前主页停留并取关。", stats, hint };
  }

  if (input.reason === "hourly-cap") {
    return {
      title: "等待每小时上限",
      wait: `已达每小时上限（${input.hourCount}/${input.hourlyCap}），${formatWaitDuration(input.countdownSec)}后自动继续。可在「设置」中切换安全档位。`,
      stats,
      hint,
    };
  }

  if (input.reason === "daily-cap") {
    return {
      title: "等待每日上限",
      wait: `已达每日上限，${formatWaitDuration(input.countdownSec)}后自动继续。可在「设置」中切换安全档位。`,
      stats,
      hint,
    };
  }

  if (input.reason === "outside-active-hours") {
    return {
      title: "等待允许时段",
      wait: `当前不在允许时段内，${formatWaitDuration(input.countdownSec)}后自动继续。可在「设置」中调整。`,
      stats,
      hint,
    };
  }

  const wait =
    input.countdownSec > 0 ? `下一项 ${formatWaitDuration(input.countdownSec)}后执行` : "下一项即将执行";

  return { title: "取关进行中", wait, stats, hint };
}
