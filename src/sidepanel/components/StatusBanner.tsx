import type { ReactNode } from "react";

interface StatusBannerProps {
  tone?: "info" | "danger" | "success";
  children: ReactNode;
}

export function StatusBanner({ tone = "info", children }: StatusBannerProps) {
  const toneClass =
    tone === "danger"
      ? "border-danger/40 bg-danger/10 text-text"
      : tone === "success"
        ? "border-accent/40 bg-accent/10 text-text"
        : "border-border bg-surface-raised text-muted";

  return (
    <div role="status" className={`mb-4 rounded-[var(--radius-panel)] border px-3 py-3 text-sm ${toneClass}`}>
      {children}
    </div>
  );
}
