import { useEffect, useState, type Dispatch, type SetStateAction } from "react";

import type { SendCommand } from "@/sidepanel/hooks/useExtensionState";
import {
  FOLLOW_RATIO_MIN_FOLLOWING,
  FOLLOW_RATIO_MULTIPLIER,
  LOW_TWEET_COUNT_THRESHOLD,
  normalizeHandle,
} from "@/shared/rules";
import { HARD_LIMITS, PRESET_LIMITS, clampSettings } from "@/shared/safety";
import type { ExtensionState, SafetyPreset, ScanStrategies, Settings } from "@/shared/types";

const SCAN_STRATEGY_OPTIONS: Array<{
  key: keyof ScanStrategies;
  label: string;
  hint?: string;
}> = [
  { key: "notFollowingBack", label: "对方未回关" },
  { key: "nonBlueVerified", label: "对方非蓝标" },
  { key: "protected", label: "对方已锁定 / 私密" },
  {
    key: "lowTweetCount",
    label: "推文极少",
    hint: `< ${LOW_TWEET_COUNT_THRESHOLD} 条`,
  },
  {
    key: "followRatio",
    label: "关注远大于粉丝",
    hint: `关注 ≥ ${FOLLOW_RATIO_MIN_FOLLOWING} 且 ≥ 粉丝 × ${FOLLOW_RATIO_MULTIPLIER}`,
  },
];

function presetPolicyCopy(preset: SafetyPreset): string {
  if (preset === "custom") {
    return `每小时 ≤${HARD_LIMITS.maxHourlyCap}，每天 ≤${HARD_LIMITS.maxDailyCap}，每会话 ≤${HARD_LIMITS.maxSessionCap}。取关间隔在下方单独设置（不低于 ${HARD_LIMITS.minIntervalSec} 秒）。`;
  }

  const limits = PRESET_LIMITS[preset];
  return `每小时 ${limits.hourlyCap}，每天 ${limits.dailyCap}，每会话 ${limits.sessionCap}。取关间隔在下方单独设置，与档位无关。`;
}

function IntervalFields({
  draft,
  setDraft,
}: {
  draft: Settings;
  setDraft: Dispatch<SetStateAction<Settings>>;
}) {
  return (
    <div className="grid grid-cols-2 gap-2.5">
      <label className="block text-sm">
        <span id="interval-min-label" className="mb-1.5 block font-medium">
          最小间隔（秒）
        </span>
        <input
          type="number"
          aria-labelledby="interval-min-label"
          min={HARD_LIMITS.minIntervalSec}
          value={Number.isFinite(draft.intervalMinSec) ? draft.intervalMinSec : ""}
          onChange={(event) =>
            setDraft((current) => ({
              ...current,
              intervalMinSec:
                event.target.value === "" ? Number.NaN : Number(event.target.value),
            }))
          }
          className="min-h-11 w-full rounded-[var(--radius-panel)] border border-border bg-surface px-3 text-sm"
        />
      </label>
      <label className="block text-sm">
        <span id="interval-max-label" className="mb-1.5 block font-medium">
          最大间隔（秒）
        </span>
        <input
          type="number"
          aria-labelledby="interval-max-label"
          min={HARD_LIMITS.minIntervalSec}
          value={Number.isFinite(draft.intervalMaxSec) ? draft.intervalMaxSec : ""}
          onChange={(event) =>
            setDraft((current) => ({
              ...current,
              intervalMaxSec:
                event.target.value === "" ? Number.NaN : Number(event.target.value),
            }))
          }
          className="min-h-11 w-full rounded-[var(--radius-panel)] border border-border bg-surface px-3 text-sm"
        />
      </label>
    </div>
  );
}

interface SettingsViewProps {
  state: ExtensionState;
  send: SendCommand;
}

export function SettingsView({ state, send }: SettingsViewProps) {
  const [handle, setHandle] = useState("");
  const [draft, setDraft] = useState(state.settings);

  useEffect(() => {
    setDraft(state.settings);
  }, [state.settings]);

  return (
    <section className="space-y-8">
      <fieldset className="space-y-6">
        <div>
          <legend className="mb-2.5 text-sm font-medium">安全档位</legend>
          <div>
            {(["safe", "balanced", "custom"] as SafetyPreset[]).map((preset) => (
              <label key={preset} className="flex min-h-8 items-center gap-2.5 text-sm">
                <input
                  type="radio"
                  name="preset"
                  checked={draft.preset === preset}
                  onChange={() => setDraft((current) => ({ ...current, preset }))}
                />
                {preset === "safe" ? "安全（默认）" : preset === "balanced" ? "均衡" : "自定义"}
              </label>
            ))}
          </div>
          <p className="mt-2 text-xs leading-relaxed text-muted">
            {presetPolicyCopy(draft.preset)}
          </p>
        </div>

        <div className="space-y-1.5">
          <legend className="mb-2.5 text-sm font-medium">取关间隔</legend>
          <IntervalFields draft={draft} setDraft={setDraft} />
          <p className="text-xs text-muted">
            默认 {PRESET_LIMITS.safe.intervalMinSec}–{PRESET_LIMITS.safe.intervalMaxSec}{" "}
            秒；低于 {HARD_LIMITS.minIntervalSec} 秒会按 {HARD_LIMITS.minIntervalSec}{" "}
            秒保存。打开主页后、以及确认框出现后，会各在此区间内随机停留一次，与安全档位无关。
          </p>
        </div>

        <label className="block text-sm">
          <span id="sync-target-count-label" className="mb-3.5 block font-medium">
            每轮同步人数
          </span>
          <input
            type="number"
            aria-labelledby="sync-target-count-label"
            min={HARD_LIMITS.minSyncTargetCount}
            max={HARD_LIMITS.maxSyncTargetCount}
            step={100}
            value={Number.isFinite(draft.syncTargetCount) ? draft.syncTargetCount : ""}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                syncTargetCount:
                  event.target.value === "" ? Number.NaN : Number(event.target.value),
              }))
            }
            className="min-h-11 w-full rounded-[var(--radius-panel)] border border-border bg-surface px-3 text-sm"
          />
          <span className="mt-1.5 block text-xs text-muted">100–5000，默认 1000</span>
        </label>

        <div>
          <legend className="mb-2.5 text-sm font-medium">扫描策略</legend>
          <div className="space-y-1">
            {SCAN_STRATEGY_OPTIONS.map(({ key, label, hint }) => (
              <label key={key} className="flex min-h-8 items-start gap-2.5 text-sm">
                <input
                  type="checkbox"
                  checked={draft.scanStrategies[key]}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      scanStrategies: {
                        ...current.scanStrategies,
                        [key]: event.target.checked,
                      },
                    }))
                  }
                  className="mt-1"
                />
                <span>
                  {label}
                  {hint ? (
                    <span className="ml-1 text-xs text-muted">({hint})</span>
                  ) : null}
                </span>
              </label>
            ))}
          </div>
          <p className="mt-2 text-xs leading-relaxed text-muted">
            满足任一已勾选规则即进入待清理列表；白名单始终排除。
          </p>
        </div>

        <button
          type="button"
          className="min-h-11 w-full rounded-[var(--radius-panel)] bg-surface-raised text-sm transition-colors hover:bg-[#252528]"
          onClick={() => {
            const settings = clampSettings(draft);
            setDraft(settings);
            send({ type: "SETTINGS_UPDATE", settings });
          }}
        >
          保存设置
        </button>
      </fieldset>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">白名单</h2>
        <div className="flex gap-2.5">
          <input
            value={handle}
            onChange={(event) => setHandle(event.target.value)}
            placeholder="@handle"
            className="min-h-11 flex-1 rounded-[var(--radius-panel)] border border-border bg-surface px-3 text-sm"
          />
          <button
            type="button"
            className="min-h-11 shrink-0 rounded-[var(--radius-panel)] border border-border px-4 text-sm transition-colors hover:bg-surface"
            onClick={() => {
              const value = handle.trim().replace(/^@+/, "").trim();
              if (value === "") {
                return;
              }
              const exists = state.whitelist.some(
                (entry) => normalizeHandle(entry.handle ?? "") === normalizeHandle(value),
              );
              if (!exists) {
                send({
                  type: "WHITELIST_UPDATE",
                  entries: [...state.whitelist, { handle: value }],
                });
              }
              setHandle("");
            }}
          >
            添加
          </button>
        </div>
        {state.whitelist.length === 0 ? (
          <p className="text-xs text-muted">暂无白名单成员。</p>
        ) : (
          <ul className="divide-y divide-border text-sm text-muted">
            {state.whitelist.map((entry, index) => {
              const label = entry.handle ? `@${entry.handle}` : (entry.userId ?? "");
              return (
                <li
                  key={`${entry.userId ?? ""}-${entry.handle ?? ""}-${index}`}
                  className="flex min-h-11 items-center gap-3 py-1"
                >
                  <span className="min-w-0 flex-1 truncate">{label}</span>
                  <button
                    type="button"
                    aria-label={`移除 ${label}`}
                    className="min-h-11 shrink-0 px-2 text-xs text-danger transition-opacity hover:opacity-80"
                    onClick={() =>
                      send({
                        type: "WHITELIST_UPDATE",
                        entries: state.whitelist.filter((_, position) => position !== index),
                      })
                    }
                  >
                    移除
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">审计日志</h2>
        <ul className="space-y-2.5 text-xs leading-relaxed text-muted">
          {state.auditLog
            .slice()
            .reverse()
            .map((entry) => (
              <li key={`${entry.at}-${entry.userId}`}>
                {new Date(entry.at).toLocaleString()} · @{entry.handle} · {entry.code}
              </li>
            ))}
        </ul>
      </section>
    </section>
  );
}
