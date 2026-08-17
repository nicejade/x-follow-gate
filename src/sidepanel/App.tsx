import { useState } from "react";

import { AppShell } from "@/sidepanel/components/AppShell";
import { StatusBanner } from "@/sidepanel/components/StatusBanner";
import { useExtensionState } from "@/sidepanel/hooks/useExtensionState";
import type { PanelTab } from "@/sidepanel/lib/metrics";
import { CleanupView } from "@/sidepanel/views/CleanupView";
import { InsightView } from "@/sidepanel/views/InsightView";
import { SettingsView } from "@/sidepanel/views/SettingsView";

export function App() {
  const { state, ready, error, send } = useExtensionState();
  const [tab, setTab] = useState<PanelTab>("insight");

  if (!ready) {
    return <p className="p-4 text-sm text-muted">正在读取本地状态…</p>;
  }

  if (error || state === null) {
    return (
      <StatusBanner tone="danger">无法读取扩展状态（{error ?? "internal-error"}）。</StatusBanner>
    );
  }

  return (
    <AppShell state={state} tab={tab} onTabChange={setTab}>
      {tab === "insight" ? <InsightView state={state} send={send} /> : null}
      {tab === "cleanup" ? <CleanupView state={state} send={send} /> : null}
      {tab === "settings" ? <SettingsView state={state} send={send} /> : null}
    </AppShell>
  );
}
