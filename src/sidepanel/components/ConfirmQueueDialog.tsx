interface ConfirmQueueDialogProps {
  count: number;
  preset: string;
  interval: string;
  eta: string;
  onCancel: () => void;
  onConfirm: () => void;
}

export function ConfirmQueueDialog({
  count,
  preset,
  interval,
  eta,
  onCancel,
  onConfirm,
}: ConfirmQueueDialogProps) {
  return (
    <div
      className="fixed inset-0 z-20 flex items-end bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="w-full rounded-[var(--radius-panel)] bg-surface p-4">
        <h2 className="text-base font-semibold">确认取关 {count} 个账号</h2>
        <p className="mt-2 text-sm text-muted">
          档位 {preset} · 间隔 {interval} · {eta}
        </p>
        <p className="mt-3 text-sm text-muted">
          X 仍可能限流或限制账号。任何自动化都无法保证零风险。队列会按安全间隔单次执行，可随时暂停。
        </p>
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            className="min-h-11 flex-1 rounded-[var(--radius-panel)] border border-border"
            onClick={onCancel}
          >
            取消
          </button>
          <button
            type="button"
            className="min-h-11 flex-1 rounded-[var(--radius-panel)] bg-accent text-bg"
            onClick={onConfirm}
          >
            确认并开始
          </button>
        </div>
      </div>
    </div>
  );
}
