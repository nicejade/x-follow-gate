/**
 * ISOLATED-world entry point.
 *
 * This is the only content-script world that may call Chrome APIs. It owns three
 * responsibilities that must never leak into the MAIN world:
 *
 * 1. Accept `FOLLOWING_PAGE_DATA` from the page only after every trust check —
 *    same window, same origin, known source and type — then re-validate the
 *    users and stamp them with the ISOLATED clock before forwarding.
 * 2. Drive the progressive scroll session when the service worker asks for one.
 * 3. Detect the signed-in account and report it before any write can proceed.
 *
 * The MAIN world posts through `window`; forged messages from iframes, other
 * origins, or a compromised page script are rejected here.
 */

import type { ExtensionMessage } from "@/shared/messages";
import { validateFollowingUsers } from "@/shared/following-batch";
import { pickProfileDwellMs } from "@/shared/safety";
import type { AccountIdentity, FollowingUser, UnfollowResult } from "@/shared/types";

import { detectAccount } from "./auth-detector";
import { FOLLOWING_PAGE_DATA, MESSAGE_SOURCE } from "./bridge-protocol";
import { createScrollController } from "./scroll-controller";
import type { ScrollController, ScrollEnvironment } from "./scroll-controller";
import { createBrowserUnfollowEnvironment, unfollowOne } from "./unfollow-driver";

export { validateFollowingUsers } from "@/shared/following-batch";
export { FOLLOWING_PAGE_DATA, MESSAGE_SOURCE } from "./bridge-protocol";

/** The subset of `window` the bridge listens on. Kept injectable for tests. */
export interface BridgeTarget {
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  location: Pick<Location, "origin">;
}

export interface FollowingBridgeOptions {
  target: BridgeTarget;
  sendMessage: (message: ExtensionMessage) => void;
  /** Always the ISOLATED / worker clock. A page-supplied `now` would defeat the re-stamp. */
  now?: () => number;
  /** Optional hook so the scroll round can measure growth from accepted batches. */
  onUsers?: (users: FollowingUser[]) => void;
}

/**
 * Installs the MAIN→ISOLATED following bridge and returns a disposer. Installing
 * twice on the same target is fine: each installation owns its own listener.
 */
export function installFollowingBridge(options: FollowingBridgeOptions): () => void {
  const { target, sendMessage, onUsers } = options;
  const now = options.now ?? (() => Date.now());

  const onMessage = (event: MessageEvent): void => {
    if (event.source !== target) {
      return;
    }

    if (event.origin !== target.location.origin) {
      return;
    }

    const data = event.data;
    if (!isRecord(data)) {
      return;
    }

    if (data.source !== MESSAGE_SOURCE || data.type !== FOLLOWING_PAGE_DATA) {
      return;
    }

    const users = validateFollowingUsers(data.users, now());
    if (users.length === 0) {
      return;
    }

    try {
      onUsers?.(users);
      sendMessage({ type: "FOLLOWING_BATCH", users });
    } catch {
      // The extension context may be gone; the page must never see that.
    }
  };

  target.addEventListener("message", onMessage);

  return () => {
    target.removeEventListener("message", onMessage);
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Live `ScrollEnvironment` bound to the current top-level document. */
export function createBrowserScrollEnvironment(
  knownUserIds: Set<string> = new Set(),
): ScrollEnvironment {
  return {
    now: () => Date.now(),
    random: () => Math.random(),
    isVisible: () => document.visibilityState === "visible",
    viewportHeight: () => window.innerHeight || document.documentElement.clientHeight || 0,
    measureDiscovered: () => knownUserIds.size,
    scrollBy: (deltaY) => {
      window.scrollBy(0, deltaY);
    },
    schedule: (callback, delayMs) => window.setTimeout(callback, delayMs),
    cancel: (timerId) => {
      window.clearTimeout(timerId);
    },
  };
}

/**
 * Delays that let the page settle before an unknown account is trusted. Finite
 * and growing, so a signed-out page costs four reads and then goes quiet.
 */
export const AUTH_SETTLE_DELAYS_MS: readonly number[] = Object.freeze([250, 750, 1_500]);

export interface AuthProbeEnvironment {
  detect(): AccountIdentity | null;
  schedule(callback: () => void, delayMs: number): number;
  cancel(timerId: number): void;
}

export interface AuthProbeOptions {
  env: AuthProbeEnvironment;
  report: (account: AccountIdentity | null) => void;
  /** Overrides the settle ladder; an empty ladder reports the first reading. */
  settleDelaysMs?: readonly number[];
}

export interface AuthProbe {
  /** Reads the account now; an unknown reading is retried before it is reported. */
  probe(): void;
  /** Drops a pending ladder, e.g. when the round it belonged to ended. */
  cancel(): void;
}

/**
 * Reports who is signed in, without letting one bad reading stop the round.
 *
 * `detectAccount` is fail-closed, so a DOM that is mid-paint or an account
 * switcher that has not rendered yet reads exactly like a signed-out page. In
 * the worker an unknown account pauses the round, and nothing re-probes until
 * the tab's visibility changes — so a single transient unknown would strand the
 * round. An unknown reading is therefore retried on a short growing ladder and
 * only reported once the page has had time to settle.
 *
 * At most one timer exists at a time and the ladder is finite, so this can never
 * degrade into a fixed-interval poll of the page.
 */
export function createAuthProbe(options: AuthProbeOptions): AuthProbe {
  const { env, report } = options;
  const delays = options.settleDelaysMs ?? AUTH_SETTLE_DELAYS_MS;

  let timerId: number | null = null;
  let attempt = 0;

  function clearTimer(): void {
    if (timerId !== null) {
      env.cancel(timerId);
      timerId = null;
    }
  }

  function read(): void {
    const account = env.detect();
    if (account !== null) {
      attempt = 0;
      report(account);

      return;
    }

    const delayMs = delays[attempt];
    if (delayMs === undefined) {
      // The page had every chance to settle; unknown is the real answer.
      attempt = 0;
      report(null);

      return;
    }

    attempt += 1;
    timerId = env.schedule(() => {
      timerId = null;
      read();
    }, delayMs);
  }

  return {
    probe(): void {
      clearTimer();
      attempt = 0;
      read();
    },
    cancel(): void {
      clearTimer();
      attempt = 0;
    },
  };
}

function sendRuntimeMessage(message: ExtensionMessage): void {
  try {
    void chrome.runtime.sendMessage(message);
  } catch {
    // The service worker may have been terminated; the page must stay undisturbed.
  }
}

function isExtensionMessage(value: unknown): value is ExtensionMessage {
  return isRecord(value) && typeof value.type === "string";
}

export interface RuntimeMessageHandlerDeps {
  authProbe: Pick<ReturnType<typeof createAuthProbe>, "probe" | "cancel">;
  ensureController: () => ScrollController;
  getController: () => ScrollController | null;
  onUnfollowOne?: (message: Extract<ExtensionMessage, { type: "UNFOLLOW_ONE" }>) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Waits on the profile, then performs one unfollow and reports the outcome. */
export async function runUnfollowCommand(
  message: Extract<ExtensionMessage, { type: "UNFOLLOW_ONE" }>,
  report: (result: UnfollowResult) => void,
  random: () => number = Math.random,
): Promise<void> {
  await sleep(
    pickProfileDwellMs(
      { minSec: message.intervalMinSec, maxSec: message.intervalMaxSec },
      random,
    ),
  );
  const result = await unfollowOne(
    message.target,
    createBrowserUnfollowEnvironment(),
    message.account,
    {
      interval: { minSec: message.intervalMinSec, maxSec: message.intervalMaxSec },
      random,
    },
  );
  report(result);
}

/** Installs the worker→content command handler. Exported for deterministic tests. */
export function createRuntimeMessageHandler(
  deps: RuntimeMessageHandlerDeps,
): (message: unknown) => { accepted: true } | undefined {
  return (message: unknown) => {
    if (!isExtensionMessage(message)) {
      return undefined;
    }

    switch (message.type) {
      case "AUTH_PROBE":
        deps.authProbe.probe();
        break;
      case "SCROLL_SESSION_START":
        deps.authProbe.probe();
        deps.ensureController().start(message.syncTargetCount);
        break;
      // Pause and stop can only concern a round that was started here, so they
      // must never bring a controller into existence.
      case "SCROLL_SESSION_PAUSE":
        deps.getController()?.pause(message.reason);
        break;
      case "SCROLL_SESSION_STOP":
        deps.getController()?.stop();
        // The round is over, so a settle ladder started for it is moot.
        deps.authProbe.cancel();
        break;
      case "UNFOLLOW_ONE":
        deps.onUnfollowOne?.(message);

        return { accepted: true };
      default:
        break;
    }

    return undefined;
  };
}

function createIsolatedRuntime(): void {
  const knownUserIds = new Set<string>();
  let controller: ScrollController | null = null;

  const remember = (users: FollowingUser[]): void => {
    for (const user of users) {
      knownUserIds.add(user.userId);
    }
  };

  const ensureController = (): ScrollController => {
    controller ??= createScrollController({
      env: createBrowserScrollEnvironment(knownUserIds),
      onStatus: (status) => {
        sendRuntimeMessage({ type: "SCROLL_STATUS", status });
      },
    });

    return controller;
  };

  installFollowingBridge({
    target: window,
    sendMessage: sendRuntimeMessage,
    onUsers: remember,
  });

  const authProbe = createAuthProbe({
    env: {
      detect: () => detectAccount(document),
      schedule: (callback, delayMs) => window.setTimeout(callback, delayMs),
      cancel: (timerId) => {
        window.clearTimeout(timerId);
      },
    },
    report: (account) => {
      sendRuntimeMessage({ type: "AUTH_STATUS", account });
    },
  });

  const handle = createRuntimeMessageHandler({
    authProbe,
    ensureController,
    getController: () => controller,
    onUnfollowOne: (message) => {
      void runUnfollowCommand(message, (result) => {
        sendRuntimeMessage({ type: "UNFOLLOW_RESULT", result });
      }).catch(() => {
        sendRuntimeMessage({
          type: "UNFOLLOW_RESULT",
          result: {
            userId: message.target.userId,
            handle: message.target.handle,
            ok: false,
            code: "verification-failed",
          },
        });
      });
    },
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const response = handle(message);
    if (response !== undefined) {
      sendResponse(response);
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      authProbe.probe();
    }
  });

  authProbe.probe();
}

// Auto-install only inside a real page. Importing this module in a test must
// have no side effect.
if (typeof window !== "undefined" && typeof chrome !== "undefined" && chrome.runtime?.id) {
  createIsolatedRuntime();
}
