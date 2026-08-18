import { useEffect, useState } from "react";

import { STATE_STORAGE_KEY } from "@/shared/defaults";
import type { ExtensionMessage } from "@/shared/messages";
import type { ExtensionState } from "@/shared/types";

/**
 * Outcome of one command. The worker answers every message, so a command that
 * the worker refused must reach the panel instead of disappearing: a button
 * that looks like it worked while nothing happened is worse than an error.
 */
export type SendOutcome = { ok: true; result: unknown } | { ok: false; code: string };

export type SendCommand = (message: ExtensionMessage) => Promise<SendOutcome>;

export interface ExtensionController {
  state: ExtensionState | null;
  ready: boolean;
  error: string | null;
  send: SendCommand;
}

interface Envelope {
  ok?: boolean;
  result?: ExtensionState;
  error?: { code?: string };
}

/** Never rejects: a transport failure is an outcome the caller has to render. */
function sendCommand(message: ExtensionMessage): Promise<SendOutcome> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response: Envelope | undefined) => {
        if (chrome.runtime.lastError || response === undefined) {
          resolve({ ok: false, code: "worker-unreachable" });
          return;
        }

        resolve(
          response.ok === true
            ? { ok: true, result: response.result }
            : { ok: false, code: response.error?.code ?? "internal-error" },
        );
      });
    } catch {
      resolve({ ok: false, code: "worker-unreachable" });
    }
  });
}

export function useExtensionState(): ExtensionController {
  const [state, setState] = useState<ExtensionState | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    chrome.runtime.sendMessage({ type: "STATE_GET" }, (response: Envelope) => {
      if (cancelled) {
        return;
      }

      if (response?.ok && response.result) {
        setState(response.result);
        setError(null);
      } else {
        setError(response?.error?.code ?? "internal-error");
      }

      setReady(true);
    });

    const onChanged: Parameters<typeof chrome.storage.onChanged.addListener>[0] = (
      changes,
      area,
    ) => {
      if (area !== "local") {
        return;
      }

      const change = changes[STATE_STORAGE_KEY];
      if (change?.newValue) {
        setState(change.newValue as ExtensionState);
      }
    };

    chrome.storage.onChanged.addListener(onChanged);

    return () => {
      cancelled = true;
      try {
        chrome.storage.onChanged.removeListener(onChanged);
      } catch {
        // The test harness may have already unstubbed chrome.
      }
    };
  }, []);

  return {
    state,
    ready,
    error,
    send: sendCommand,
  };
}
