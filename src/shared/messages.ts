/**
 * Typed message protocol between the side panel, the content scripts, and the
 * MV3 service worker.
 *
 * The union is the single compile-time contract for every runtime message; any
 * handler that switches on `type` must end in `assertNever`, so adding a
 * variant breaks the build instead of silently falling through at runtime.
 */

import type {
  AccountIdentity,
  FollowingUser,
  QueuePauseReason,
  ScrollStatus,
  Settings,
  SyncPauseReason,
  UnfollowResult,
  WhitelistEntry,
} from "./types";

/**
 * Pause reasons a client may request. `auth` and `queue-running` are derived by
 * the worker itself, so they are not accepted over the wire.
 */
export type SyncPauseCommandReason = Extract<
  SyncPauseReason,
  "user" | "hidden" | "budget" | "stalled"
>;

export type ExtensionMessage =
  | { type: "STATE_GET" }
  | { type: "SYNC_START" }
  | { type: "SYNC_PAUSE"; reason: SyncPauseCommandReason }
  | { type: "SYNC_STOP" }
  | { type: "FOLLOWING_BATCH"; users: FollowingUser[] }
  | { type: "SCROLL_STATUS"; status: ScrollStatus }
  // Worker → content script. The worker owns the round; the content script only
  // reacts to these three commands and never decides to scroll on its own.
  | { type: "SCROLL_SESSION_START"; syncTargetCount: number }
  | { type: "SCROLL_SESSION_PAUSE"; reason: SyncPauseReason }
  | { type: "SCROLL_SESSION_STOP" }
  /** Content script → worker. `null` means "unknown" and blocks every write. */
  | { type: "AUTH_STATUS"; account: AccountIdentity | null }
  | { type: "QUEUE_START"; userIds: string[] }
  | { type: "QUEUE_PAUSE"; reason: QueuePauseReason }
  | { type: "QUEUE_STOP" }
  | { type: "UNFOLLOW_READY"; tabId: number; account: AccountIdentity | null }
  /**
   * Worker → content script. One command performs at most one unfollow. The
   * expected owner travels with the target so the driver can refuse to act on a
   * page that belongs to a different account.
   */
  | { type: "UNFOLLOW_ONE"; target: FollowingUser; account: AccountIdentity }
  | { type: "UNFOLLOW_RESULT"; result: UnfollowResult }
  | { type: "SETTINGS_UPDATE"; settings: Settings }
  | { type: "WHITELIST_UPDATE"; entries: WhitelistEntry[] };

export type ExtensionMessageType = ExtensionMessage["type"];

const MESSAGE_TYPES: ReadonlySet<string> = new Set<ExtensionMessageType>([
  "STATE_GET",
  "SYNC_START",
  "SYNC_PAUSE",
  "SYNC_STOP",
  "FOLLOWING_BATCH",
  "SCROLL_STATUS",
  "SCROLL_SESSION_START",
  "SCROLL_SESSION_PAUSE",
  "SCROLL_SESSION_STOP",
  "AUTH_STATUS",
  "QUEUE_START",
  "QUEUE_PAUSE",
  "QUEUE_STOP",
  "UNFOLLOW_READY",
  "UNFOLLOW_ONE",
  "UNFOLLOW_RESULT",
  "SETTINGS_UPDATE",
  "WHITELIST_UPDATE",
]);

export function isExtensionMessage(value: unknown): value is ExtensionMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof (value as { type: unknown }).type === "string" &&
    MESSAGE_TYPES.has((value as { type: string }).type)
  );
}

/**
 * Exhaustiveness guard for `switch` statements over a discriminated union.
 * Reaching it at runtime means an untyped sender crossed the boundary.
 */
export function assertNever(value: never): never {
  throw new Error(`Unhandled message variant: ${JSON.stringify(value)}`);
}
