/**
 * Coordinates progressive Following sync from the service worker.
 *
 * The worker never scrolls and never asks X for data. Its only jobs are:
 *
 * 1. Refuse to start a round while the unfollow queue is active.
 * 2. Put a visible Following tab in front of the signed-in user and ask the
 *    content script to scroll it.
 * 3. Merge batches that the ISOLATED world has already re-stamped, then persist
 *    progress and pause reasons so a worker restart can resume cleanly.
 *
 * Timestamps are always the worker clock. A content-supplied `syncedAt` is
 * re-stamped again here, so even a compromised content script cannot rewrite
 * history.
 */

import { applyFollowingBatch, loadState, updateState } from "@/background/store";
import { createDefaultSyncMeta } from "@/shared/defaults";
import { validateFollowingUsers } from "@/shared/following-batch";
import type { ExtensionMessage } from "@/shared/messages";
import { normalizeHandle, normalizeUserId } from "@/shared/rules";
import type {
  AccountIdentity,
  ExtensionState,
  ScrollStatus,
  SyncMeta,
  SyncPauseReason,
  SyncStatus,
  UnfollowQueue,
} from "@/shared/types";

export type StartSyncReason = "queue-running" | "auth" | "missing-tab";

export type RefreshAuthReason = "missing-tab";

export type RefreshAuthResult =
  | { ok: true; delivered: boolean }
  | { ok: false; reason: RefreshAuthReason };

export type StartSyncResult =
  { ok: true; tabId: number; delivered: boolean } | { ok: false; reason: StartSyncReason };

const X_HOSTS = ["x.com", "twitter.com"] as const;
const SYNC_PAUSE_REASONS = new Set<SyncPauseReason>([
  "user",
  "hidden",
  "budget",
  "stalled",
  "auth",
  "queue-running",
  "missing-tab",
]);
const SYNC_STATUSES = new Set<SyncStatus>(["idle", "running", "paused", "completed", "stopped"]);

interface TabLike {
  id?: number;
  url?: string;
  active?: boolean;
}

/** True when the unfollow path would write, which permanently excludes sync. */
export function isQueueBlockingSync(queue: UnfollowQueue, now: number): boolean {
  if (queue.status === "running" || queue.status === "cooldown") {
    return true;
  }

  if (queue.cooldownUntil !== null && queue.cooldownUntil > now) {
    return true;
  }

  return queue.items.some((item) => item.status === "in-flight");
}

export function followingPageUrl(handle: string): string {
  return `https://x.com/${normalizeHandle(handle)}/following`;
}

export function isFollowingPageUrl(url: string | undefined, handle: string): boolean {
  if (typeof url !== "string" || url === "") {
    return false;
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (parsed.protocol !== "https:" || !isXHost(parsed.hostname)) {
    return false;
  }

  const expected = `/${normalizeHandle(handle)}/following`;
  const path = parsed.pathname.replace(/\/+$/, "").toLowerCase();

  return path === expected;
}

function isXHost(hostname: string): boolean {
  return X_HOSTS.some((host) => hostname === host || hostname.endsWith(`.${host}`));
}

function isXUrl(url: string | undefined): boolean {
  if (typeof url !== "string" || url === "") {
    return false;
  }

  try {
    const parsed = new URL(url);

    return parsed.protocol === "https:" && isXHost(parsed.hostname);
  } catch {
    return false;
  }
}

async function findFollowingTab(handle: string): Promise<TabLike | null> {
  const tabs = await chrome.tabs.query({ url: ["https://x.com/*", "https://twitter.com/*"] });

  return tabs.find((tab) => isFollowingPageUrl(tab.url, handle)) ?? null;
}

async function findAnyXTab(): Promise<TabLike | null> {
  const tabs = await chrome.tabs.query({ url: ["https://x.com/*", "https://twitter.com/*"] });

  return tabs.find((tab) => typeof tab.id === "number" && isXUrl(tab.url)) ?? null;
}

async function ensureFollowingTab(handle: string): Promise<number | null> {
  const url = followingPageUrl(handle);

  try {
    const open = await findFollowingTab(handle);
    if (typeof open?.id === "number") {
      await chrome.tabs.update(open.id, { active: true });

      return open.id;
    }

    const reusable = await findAnyXTab();
    if (typeof reusable?.id === "number") {
      await chrome.tabs.update(reusable.id, { url, active: true });

      return reusable.id;
    }

    const created = await chrome.tabs.create({ url, active: true });

    return typeof created.id === "number" ? created.id : null;
  } catch {
    // A tab can be closed between the query and the update. The round is
    // reported as `missing-tab` instead of failing the caller, so the user sees
    // a reason and can retry.
    return null;
  }
}

async function sendToTab(tabId: number, message: ExtensionMessage): Promise<boolean> {
  try {
    await chrome.tabs.sendMessage(tabId, message);

    return true;
  } catch {
    // The content script may not be ready yet; the round stays running and the
    // next AUTH_STATUS / page load will deliver the command.
    return false;
  }
}

/**
 * Sends a round command to the Following tab. The transition is already
 * persisted when this runs, so a failure is reported rather than raised: the
 * worker's view is authoritative, but the content round may not have heard it.
 */
async function sendToFollowingTab(
  handle: string | null,
  message: ExtensionMessage,
): Promise<boolean> {
  if (handle === null) {
    return false;
  }

  try {
    const tab = await findFollowingTab(handle);

    return typeof tab?.id === "number" ? await sendToTab(tab.id, message) : false;
  } catch {
    return false;
  }
}

/** Makes a worker/content divergence visible instead of silently dropping it. */
function warnUndelivered(message: ExtensionMessage): void {
  console.warn(
    `[follow-gate] ${message.type} was not delivered; the round state is worker-only until the tab reports again`,
  );
}

function freshRunningMeta(state: ExtensionState, now: number): SyncMeta {
  return {
    ...createDefaultSyncMeta(),
    status: "running",
    startedAt: now,
    updatedAt: now,
    discoveredCount: Object.keys(state.following).length,
  };
}

async function markPaused(reason: SyncPauseReason, now: number): Promise<void> {
  await updateState((state) => ({
    ...state,
    syncMeta: {
      ...state.syncMeta,
      status: "paused",
      updatedAt: now,
      pauseReason: reason,
    },
  }));
}

/**
 * Starts a scroll round for the signed-in account. Mutual exclusion with the
 * unfollow queue is enforced before any tab is touched.
 */
export async function startSync(now: number = Date.now()): Promise<StartSyncResult> {
  const state = await loadState();

  if (isQueueBlockingSync(state.unfollowQueue, now)) {
    await markPaused("queue-running", now);

    return { ok: false, reason: "queue-running" };
  }

  const account = state.session.account;
  if (account === null) {
    await markPaused("auth", now);

    return { ok: false, reason: "auth" };
  }

  const tabId = await ensureFollowingTab(account.handle);
  if (tabId === null) {
    await markPaused("missing-tab", now);

    return { ok: false, reason: "missing-tab" };
  }

  await updateState((current) => ({
    ...current,
    syncMeta: freshRunningMeta(current, now),
  }));

  const delivered = await sendToTab(tabId, {
    type: "SCROLL_SESSION_START",
    syncTargetCount: state.settings.syncTargetCount,
  });

  return { ok: true, tabId, delivered };
}

/**
 * A user pause is sticky: only the user may replace it. An automatic reason must
 * never overwrite it, because `hidden` is the one reason the content controller
 * resumes from on its own.
 */
function replacesPauseReason(current: SyncPauseReason | null, next: SyncPauseReason): boolean {
  return current !== next && (current !== "user" || next === "user");
}

export async function pauseSync(reason: SyncPauseReason, now: number = Date.now()): Promise<void> {
  const state = await loadState();
  const { status, pauseReason } = state.syncMeta;
  if (status !== "running" && status !== "paused") {
    return;
  }

  // An already paused round is retargeted instead of paused again, so a user
  // pause can cancel the auto-resume that a `hidden` pause leaves armed.
  if (status === "paused" && !replacesPauseReason(pauseReason, reason)) {
    return;
  }

  await updateState((current) => ({
    ...current,
    syncMeta: {
      ...current.syncMeta,
      status: "paused",
      updatedAt: now,
      pauseReason: reason,
    },
  }));

  const command: ExtensionMessage = { type: "SCROLL_SESSION_PAUSE", reason };
  if (!(await sendToFollowingTab(state.session.account?.handle ?? null, command))) {
    warnUndelivered(command);
  }
}

export async function stopSync(now: number = Date.now()): Promise<void> {
  const state = await loadState();
  if (state.syncMeta.status === "idle" || state.syncMeta.status === "stopped") {
    return;
  }

  await updateState((current) => ({
    ...current,
    syncMeta: {
      ...current.syncMeta,
      status: "stopped",
      updatedAt: now,
      pauseReason: null,
    },
  }));

  const command: ExtensionMessage = { type: "SCROLL_SESSION_STOP" };
  if (!(await sendToFollowingTab(state.session.account?.handle ?? null, command))) {
    warnUndelivered(command);
  }
}

/**
 * Accepts a following batch from the content script. The users are re-validated
 * and re-stamped with the worker clock before they touch storage.
 */
export async function ingestFollowingBatch(
  users: unknown,
  now: number = Date.now(),
): Promise<void> {
  const validated = validateFollowingUsers(users, now);
  if (validated.length === 0) {
    return;
  }

  await updateState((state) => {
    const merged = applyFollowingBatch(state, validated);
    if (merged.syncMeta.status === "idle" || merged.syncMeta.status === "stopped") {
      return merged;
    }

    return {
      ...merged,
      syncMeta: {
        ...merged.syncMeta,
        discoveredCount: Math.max(
          merged.syncMeta.discoveredCount,
          Object.keys(merged.following).length,
        ),
        updatedAt: now,
      },
    };
  });
}

function nonNegativeInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function sanitizeScrollStatus(status: ScrollStatus, fallback: SyncMeta): SyncMeta {
  const nextStatus = SYNC_STATUSES.has(status.status) ? status.status : fallback.status;
  const pauseReason =
    status.pauseReason === null
      ? null
      : SYNC_PAUSE_REASONS.has(status.pauseReason)
        ? status.pauseReason
        : fallback.pauseReason;

  return {
    ...fallback,
    status: nextStatus,
    stepCount: nonNegativeInt(status.stepCount),
    discoveredCount: Math.max(fallback.discoveredCount, nonNegativeInt(status.discoveredCount)),
    noGrowthSteps: nonNegativeInt(status.noGrowthSteps),
    likelyComplete: status.likelyComplete === true,
    pauseReason: nextStatus === "stopped" ? null : pauseReason,
  };
}

/** A pause only the worker may leave: the controller never resumes from these. */
function isStickyPause(meta: SyncMeta): boolean {
  return meta.status === "paused" && (meta.pauseReason === "user" || meta.pauseReason === "auth");
}

/**
 * A report that was already in flight when the worker ended or froze the round
 * must not revive it, and must not rewrite the reason the panel shows either. A
 * stop is the one transition still accepted: the content round really is over.
 */
function isStaleReport(current: SyncMeta, status: ScrollStatus): boolean {
  if (current.status === "stopped" || isStickyPause(current)) {
    return status.status !== "stopped";
  }

  return false;
}

export async function applyScrollStatus(
  status: ScrollStatus,
  now: number = Date.now(),
): Promise<void> {
  await updateState((state) => {
    if (isStaleReport(state.syncMeta, status)) {
      return state;
    }

    const next = sanitizeScrollStatus(status, state.syncMeta);

    return {
      ...state,
      syncMeta: {
        ...next,
        startedAt:
          next.status === "running" && state.syncMeta.startedAt === null
            ? now
            : state.syncMeta.startedAt,
        updatedAt: now,
        discoveredCount: Math.max(next.discoveredCount, Object.keys(state.following).length),
      },
    };
  });
}

function normalizeAccount(account: AccountIdentity | null): AccountIdentity | null {
  if (account === null || typeof account !== "object") {
    return null;
  }

  const userId = normalizeUserId(account.userId);
  const handle = normalizeHandle(account.handle);

  return userId !== "" && handle !== "" ? { userId, handle } : null;
}

function sameAccount(left: AccountIdentity | null, right: AccountIdentity | null): boolean {
  return (
    left !== null && right !== null && left.userId === right.userId && left.handle === right.handle
  );
}

/**
 * Persists the latest auth probe.
 *
 * Two outcomes are not the same and must not be handled the same way:
 *
 * - The account merely became unreadable. The owner is still whoever it was, so
 *   the stored Following map keeps describing them; only writes are blocked.
 * - The account switched. The stored map now describes somebody else, so the new
 *   identity is *not* adopted: the session drops to unknown and the map and the
 *   candidate snapshot are discarded. The next probe adopts the new account with
 *   an empty map, which is the only way a write path can trust `session.account`
 *   and `following` together. The whitelist, settings, and audit log survive,
 *   because they are the user's, not the account's.
 *
 * Either outcome pauses an active round with `auth`. A matching account on a
 * running round re-delivers the scroll command, which covers a content script
 * that missed the original `SCROLL_SESSION_START`.
 */
/** Asks an open x.com tab to re-probe the signed-in account. */
export async function refreshAuth(): Promise<RefreshAuthResult> {
  const tab = await findAnyXTab();
  if (typeof tab?.id !== "number") {
    return { ok: false, reason: "missing-tab" };
  }

  const delivered = await sendToTab(tab.id, { type: "AUTH_PROBE" });

  return { ok: true, delivered };
}

export async function applyAuthStatus(
  account: AccountIdentity | null,
  tabId: number,
  now: number = Date.now(),
): Promise<void> {
  const normalized = normalizeAccount(account);
  const before = await loadState();
  const owner = before.session.account;
  const roundActive = before.syncMeta.status === "running" || before.syncMeta.status === "paused";
  const switched = owner !== null && normalized !== null && !sameAccount(owner, normalized);
  const authLost = roundActive && (normalized === null || switched);

  await updateState((state) => {
    const next: ExtensionState = switched
      ? {
          ...state,
          session: { account: null, checkedAt: now },
          following: {},
          candidates: [],
          syncMeta: { ...state.syncMeta, discoveredCount: 0 },
        }
      : { ...state, session: { account: normalized, checkedAt: now } };

    if (!authLost) {
      return next;
    }

    return {
      ...next,
      syncMeta: {
        ...next.syncMeta,
        status: "paused",
        updatedAt: now,
        pauseReason: "auth",
      },
    };
  });

  if (authLost) {
    await sendToTab(tabId, { type: "SCROLL_SESSION_PAUSE", reason: "auth" });

    return;
  }

  if (before.syncMeta.status === "running" && sameAccount(owner, normalized)) {
    await sendToTab(tabId, {
      type: "SCROLL_SESSION_START",
      syncTargetCount: before.settings.syncTargetCount,
    });
  }
}
