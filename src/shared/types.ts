/**
 * Domain models shared by the service worker, content scripts, and side panel.
 *
 * Every type here must stay JSON-serializable because the whole state tree is
 * persisted in `chrome.storage.local`, which is the single source of truth for
 * the ephemeral MV3 service worker.
 */

/**
 * Whether the target account follows the signed-in user back.
 * `null` means "unknown"; it must never be downgraded to `false`, because an
 * unknown relationship would otherwise produce an unfollow candidate.
 */
export type RelationshipState = true | false | null;

export interface FollowingUser {
  userId: string;
  /** Lowercase handle without the leading `@`. */
  handle: string;
  name: string;
  avatarUrl: string | null;
  followedBy: RelationshipState;
  syncedAt: number;
}

export interface AccountIdentity {
  userId: string;
  /** Lowercase handle without the leading `@`. */
  handle: string;
}

export interface SessionState {
  account: AccountIdentity | null;
  checkedAt: number | null;
}

/** A whitelist entry matches by user id, by handle, or by both. */
export interface WhitelistEntry {
  userId?: string;
  handle?: string;
}

export type SafetyPreset = "safe" | "balanced" | "custom";

/** Local-time window in which write operations are allowed. */
export interface ActiveHours {
  enabled: boolean;
  /** `HH:MM` in 24-hour local time. */
  start: string;
  /** `HH:MM` in 24-hour local time. */
  end: string;
}

export interface Settings {
  preset: SafetyPreset;
  intervalMinSec: number;
  intervalMaxSec: number;
  hourlyCap: number;
  dailyCap: number;
  sessionCap: number;
  activeHours: ActiveHours;
}

export type SyncStatus = "idle" | "running" | "paused" | "completed" | "stopped";

export type SyncPauseReason =
  "user" | "hidden" | "budget" | "stalled" | "auth" | "queue-running" | "missing-tab";

export interface SyncMeta {
  status: SyncStatus;
  startedAt: number | null;
  updatedAt: number | null;
  stepCount: number;
  discoveredCount: number;
  noGrowthSteps: number;
  /** Set when the scroll round reached the end of the Following list. */
  likelyComplete: boolean;
  pauseReason: SyncPauseReason | null;
}

/**
 * Progress report emitted by the content scroll controller.
 *
 * The field names mirror `SyncMeta` so the service worker can merge a report
 * without translating it. Timestamps are deliberately absent: only the worker
 * clock may write them.
 */
export interface ScrollStatus {
  status: SyncStatus;
  stepCount: number;
  discoveredCount: number;
  noGrowthSteps: number;
  likelyComplete: boolean;
  pauseReason: SyncPauseReason | null;
}

export type QueueStatus = "idle" | "running" | "paused" | "cooldown" | "completed" | "stopped";

export type QueuePauseReason =
  | "user"
  | "session-cap"
  | "hourly-cap"
  | "daily-cap"
  | "outside-active-hours"
  | "missing-tab"
  | "auth-required"
  | "account-mismatch"
  | "rate-limited"
  | "consecutive-failures";

export type UnfollowResultCode =
  | "success"
  | "already-unfollowed"
  | "auth-required"
  | "account-mismatch"
  | "challenge"
  | "rate-limited"
  | "target-mismatch"
  | "control-missing"
  | "confirmation-missing"
  | "verification-failed";

/**
 * Outcome of one unfollow attempt reported by the content driver.
 *
 * The audit timestamp is stamped by the service worker when the result is
 * recorded, so a page-supplied clock can never rewrite quota history.
 */
export interface UnfollowResult {
  userId: string;
  /** Lowercase handle without the leading `@`. */
  handle: string;
  ok: boolean;
  code: UnfollowResultCode;
}

export type QueueItemStatus = "pending" | "in-flight" | "done" | "failed" | "skipped";

export interface UnfollowQueueItem {
  userId: string;
  /** Lowercase handle without the leading `@`. */
  handle: string;
  status: QueueItemStatus;
  attempts: number;
  lastCode: UnfollowResultCode | null;
}

export interface UnfollowQueue {
  status: QueueStatus;
  items: UnfollowQueueItem[];
  /** Index of the item the queue is working on. */
  cursor: number;
  /** Persisted schedule for the next attempt; survives service-worker restarts. */
  nextAt: number | null;
  sessionStartedAt: number | null;
  /**
   * Timestamps of performed unfollow actions, kept as a list instead of
   * counters so hourly and daily quotas cannot drift out of sync.
   */
  actionTimestamps: number[];
  cooldownUntil: number | null;
  pauseReason: QueuePauseReason | null;
  consecutiveFailures: number;
  /** Account that started the queue; a mismatch must stop write operations. */
  ownerUserId: string | null;
}

export interface AuditEntry {
  at: number;
  userId: string;
  handle: string;
  ok: boolean;
  code: UnfollowResultCode;
}

export type QuotaBlockReason =
  | "queue-not-running"
  | "cooldown"
  | "outside-active-hours"
  | "session-cap"
  | "hourly-cap"
  | "daily-cap"
  | "waiting-interval";

export interface QuotaDecision {
  allowed: boolean;
  reason: QuotaBlockReason | null;
  /** Earliest moment the block may clear, or `null` when user action is required. */
  retryAt: number | null;
}

export interface ExtensionState {
  version: number;
  session: SessionState;
  /** Keyed by `userId`. */
  following: Record<string, FollowingUser>;
  syncMeta: SyncMeta;
  whitelist: WhitelistEntry[];
  /** Snapshot of candidate user ids from the latest preview. */
  candidates: string[];
  unfollowQueue: UnfollowQueue;
  settings: Settings;
  auditLog: AuditEntry[];
}
