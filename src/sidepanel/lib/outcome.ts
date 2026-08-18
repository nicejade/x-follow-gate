import type { SendOutcome } from "@/sidepanel/hooks/useExtensionState";

/**
 * Transport-level failures. These are the same for every command: the panel
 * never reached a worker that could accept or refuse it.
 */
const TRANSPORT_COPY: Record<string, string> = {
  "worker-unreachable": "扩展后台没有响应，请在扩展管理页重新加载本扩展后重试。",
  "unknown-message": "扩展版本不一致，请重新加载本扩展。",
  "internal-error": "扩展内部错误，请重新加载本扩展后重试。",
};

export interface QueueStartFeedback {
  error: string | null;
  success: string | null;
}

/**
 * Turns a command outcome into a sentence, or `null` when it succeeded.
 *
 * The worker answers a refusal with `{ ok: false, reason }` inside a successful
 * envelope, so a caller that only checks the envelope would report success for
 * a command that did nothing. Every refusal has to reach the user: a control
 * that appears to work while nothing happens is the worst failure mode there
 * is.
 */
export function describeOutcome(
  outcome: SendOutcome,
  blockCopy: Record<string, string>,
): string | null {
  if (!outcome.ok) {
    return TRANSPORT_COPY[outcome.code] ?? `操作失败（${outcome.code}）。`;
  }

  const result = outcome.result;
  if (typeof result !== "object" || result === null) {
    return null;
  }

  const { ok, reason } = result as { ok?: unknown; reason?: unknown };
  if (ok !== false) {
    return null;
  }

  const code = typeof reason === "string" ? reason : "internal-error";

  return blockCopy[code] ?? TRANSPORT_COPY[code] ?? `操作失败（${code}）。`;
}

/** Surfaces both refusal and the positive acknowledgement a start deserves. */
export function describeQueueStart(
  outcome: SendOutcome,
  blockCopy: Record<string, string>,
): QueueStartFeedback {
  const error = describeOutcome(outcome, blockCopy);
  if (error !== null) {
    return { error, success: null };
  }

  if (!outcome.ok) {
    return { error: null, success: null };
  }

  const result = outcome.result;
  if (typeof result !== "object" || result === null) {
    return { error: null, success: null };
  }

  const { ok, plan } = result as { ok?: unknown; plan?: { nextAt?: number | null } };
  if (ok !== true) {
    return { error: null, success: null };
  }

  const seconds =
    typeof plan?.nextAt === "number"
      ? Math.max(1, Math.ceil((plan.nextAt - Date.now()) / 1000))
      : null;

  return {
    error: null,
    success:
      seconds === null
        ? "队列已启动。将打开目标主页并按安全间隔执行取关。"
        : `队列已启动。已打开首个目标主页，约 ${seconds} 秒后执行第一次取关。`,
  };
}
