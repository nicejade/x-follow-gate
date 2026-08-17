import { useEffect, useState } from "react";

import { STATE_STORAGE_KEY } from "@/shared/defaults";
import type { ExtensionMessage } from "@/shared/messages";
import type { ExtensionState } from "@/shared/types";

export interface ExtensionController {
  state: ExtensionState | null;
  ready: boolean;
  error: string | null;
  send: (message: ExtensionMessage) => void;
}

interface Envelope {
  ok?: boolean;
  result?: ExtensionState;
  error?: { code?: string };
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
    send: (message) => {
      chrome.runtime.sendMessage(message);
    },
  };
}
