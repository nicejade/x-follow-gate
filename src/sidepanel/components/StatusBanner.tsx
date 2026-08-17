import type { ReactNode } from "react";

interface StatusBannerProps {
  tone?: "info" | "danger";
  children: ReactNode;
}

export function StatusBanner({ tone = "info", children }: StatusBannerProps) {
  return (
    <div
      role="status"
      className={`mb-4 rounded-[var(--radius-panel)] border px-3 py-3 text-sm ${
        tone === "danger"
          ? "border-danger/40 bg-danger/10 text-text"
          : "border-border bg-surface-raised text-muted"
      }`}
    >
      {children}
    </div>
  );
}
