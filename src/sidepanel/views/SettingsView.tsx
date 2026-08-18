import { useState } from "react";

import type { SendCommand } from "@/sidepanel/hooks/useExtensionState";
import { normalizeHandle } from "@/shared/rules";
import { HARD_LIMITS, clampSettings } from "@/shared/safety";
import type { ExtensionState, SafetyPreset } from "@/shared/types";

interface SettingsViewProps {
  state: ExtensionState;
  send: SendCommand;
}

export function SettingsView({ state, send }: SettingsViewProps) {
  const [handle, setHandle] = useState("");
  const [draft, setDraft] = useState(state.settings);

  return (
    <section className="space-y-8">
      <fieldset className="space-y-6">
        <div className="space-y-3">
          <legend className="text-sm font-medium">安全档位</legend>
          <div className="space-y-1">
            {(["safe", "balanced", "custom"] as SafetyPreset[]).map((preset) => (
              <label key={preset} className="flex min-h-11 items-center gap-2.5 text-sm">
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
          {draft.preset === "custom" ? (
            <p className="text-xs leading-relaxed text-muted">
              间隔不低于 {HARD_LIMITS.minIntervalSec} 秒；每小时 ≤{HARD_LIMITS.maxHourlyCap}，每天 ≤
              {HARD_LIMITS.maxDailyCap}，每会话 ≤{HARD_LIMITS.maxSessionCap}。起止相同时视为全天开放。
            </p>
          ) : null}
        </div>

        <label className="block space-y-2.5 text-sm">
          <span id="sync-target-count-label" className="font-medium">
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
          <span className="block text-xs text-muted">100–5000，默认 1000</span>
        </label>

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
