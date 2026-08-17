import type { ReactNode } from "react";

import {
  PRESET_LABELS,
  TAB_LABELS,
  todayUnfollowCount,
  type PanelTab,
} from "@/sidepanel/lib/metrics";
import type { ExtensionState } from "@/shared/types";

interface AppShellProps {
  state: ExtensionState;
  tab: PanelTab;
  onTabChange: (tab: PanelTab) => void;
  now?: number;
  children: ReactNode;
}

export function AppShell({ state, tab, onTabChange, now = Date.now(), children }: AppShellProps) {
  const signedIn = state.session.account !== null;
  const today = todayUnfollowCount(state, now);

  return (
    <div className="flex min-h-screen flex-col bg-bg text-text">
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <div>
          <p className="text-[11px] tracking-[0.18em] text-muted uppercase">Follow Gate</p>
          <h1 className="text-base font-semibold">关注门卫</h1>
        </div>
        <p
          className={`min-h-11 rounded-full px-3 py-2 text-sm ${
            signedIn ? "bg-surface-raised text-text" : "bg-danger/15 text-danger"
          }`}
        >
          {signedIn ? `已登录 @${state.session.account?.handle}` : "未登录"}
        </p>
      </header>

      <nav className="grid grid-cols-3 border-b border-border">
        {(Object.keys(TAB_LABELS) as PanelTab[]).map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => onTabChange(id)}
            className={`min-h-11 text-sm ${
              tab === id ? "border-b-2 border-accent text-text" : "text-muted"
            }`}
          >
            {TAB_LABELS[id]}
          </button>
        ))}
      </nav>

      <main className="flex-1 px-4 py-4">{children}</main>

      <footer className="border-t border-border px-4 py-3 text-xs text-muted">
        {PRESET_LABELS[state.settings.preset]} · 今日 {today}/{state.settings.dailyCap}
      </footer>
    </div>
  );
}
