import type { ExtensionState, SafetyPreset } from "@/shared/types";
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
