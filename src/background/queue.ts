/**
 * The conservative unfollow state machine.
 *
 * This is the only place in the extension that can cause a write on X, so it is
 * built to refuse rather than to act. The invariants it holds:
 *
 * - **Explicit intent.** Only user-selected ids enter, and each one is re-derived
 *   from the *current* following map and whitelist — at start and again on every
 *   tick. An unknown relationship (`followedBy === null`) is never a candidate.
 * - **Single flight.** At most one item is in flight, extension-wide, ever.
 * - **Schedule first.** `nextAt` is persisted before the alarm is armed and
 *   before any command is sent, so a worker that dies mid-tick wakes up with a
 *   schedule that is at least as conservative as the one it planned.
 * - **Never early.** An execution requires `now >= nextAt`, quota headroom, and
 *   an open active-hours window. Nothing shortens an interval that was drawn.
 * - **One owner.** The account that started the session must still be the signed-in
 *   account. `null` or a different account stops the queue; a new account is
 *   never adopted.
 * - **Mutual exclusion.** A live scroll round refuses a queue start, and a live
 *   queue refuses a scroll round (`isQueueBlockingSync`).
 *
 * Pure transitions carry the policy; the async wrappers only persist them and
 * talk to `chrome.alarms` / the write tab, because `chrome.storage.local` is the
 * single source of truth for an MV3 worker that can be killed between events.
 */

import { loadState, updateState } from "@/background/store";
import { routeToProfile, sendUnfollowOne } from "@/background/tab-router";
import type { RouteOptions } from "@/background/tab-router";
import { normalizeUserId, selectCandidates } from "@/shared/rules";
import {
  canRunNext,
  clampSettings,
  COOLDOWN_MS,
  isSyncBlockingQueue,
  pickIntervalMs,
  purgeExpiredTimestamps,
} from "@/shared/safety";
import type {
  AuditEntry,
  ExtensionState,
  FollowingUser,
  QueuePauseReason,
  Settings,
  UnfollowQueue,
  UnfollowQueueItem,
  UnfollowResult,
  UnfollowResultCode,
} from "@/shared/types";

/** The single alarm that drives the queue. */
export const UNFOLLOW_ALARM_NAME = "follow-gate:unfollow-tick";

/** One transient retry per target: the first attempt plus one more. */
export const MAX_ATTEMPTS_PER_ITEM = 2;

/** Consecutive failures that trip the circuit breaker. */
export const FAILURE_BREAKER_THRESHOLD = 3;

/** Audit history kept in storage; older entries are dropped oldest-first. */
export const MAX_AUDIT_ENTRIES = 200;

/** A selection larger than this is malformed input, not a user decision. */
export const MAX_SELECTED_IDS = 1_000;

export interface QueuePlan {
  action: "execute" | "wait" | "pause" | "complete";
  nextAt: number | null;
  reason?: QueuePauseReason;
  target?: UnfollowQueueItem;
}

export type QueueStartBlockReason =
  "auth-required" | "queue-active" | "cooldown" | "sync-running" | "no-candidates";

export type StartQueueResult =
  { ok: true; state: ExtensionState } | { ok: false; reason: QueueStartBlockReason };

export type StartUnfollowQueueResult =
  { ok: true; plan: QueuePlan } | { ok: false; reason: QueueStartBlockReason };

/** Results that mean the action happened; both spend quota. */
const COMPLETED_CODES = new Set<UnfollowResultCode>(["success", "already-unfollowed"]);

/** Results that break the circuit immediately, without a failure streak. */
const BREAKER_REASONS = new Map<UnfollowResultCode, QueuePauseReason>([
  ["auth-required", "auth-required"],
  ["challenge", "auth-required"],
  ["rate-limited", "rate-limited"],
]);

/** Page-side hiccups that earn one retry; everything else is skipped at once. */
const RETRYABLE_CODES = new Set<UnfollowResultCode>([
  "control-missing",
  "confirmation-missing",
  "verification-failed",
]);

const RESULT_CODES = new Set<UnfollowResultCode>([
  "success",
  "already-unfollowed",
  "auth-required",
  "account-mismatch",
  "challenge",
  "rate-limited",
  "target-mismatch",
  "control-missing",
  "confirmation-missing",
  "verification-failed",
]);

export function isUnfollowAlarm(name: string): boolean {
  return name === UNFOLLOW_ALARM_NAME;
}

export { isSyncBlockingQueue };

/**
 * Re-derives the selected ids from live state.
 *
 * The candidate snapshot in storage is a UI convenience and may be stale, so it
 * is deliberately ignored here: the relationship and the whitelist are read
 * again, which is what keeps a whitelisted or newly mutual account out of the
 * queue even if it was selected minutes ago.
 */
export function selectQueueTargets(state: ExtensionState, userIds: string[]): FollowingUser[] {
  if (!Array.isArray(userIds) || userIds.length > MAX_SELECTED_IDS) {
    return [];
  }

  const allowed = new Map(
    selectCandidates(Object.values(state.following), state.whitelist).map((user) => [
      user.userId,
      user,
    ]),
  );

  const targets: FollowingUser[] = [];
  const seen = new Set<string>();
  for (const rawId of userIds) {
    const userId = normalizeUserId(typeof rawId === "string" ? rawId : "");
    const user = allowed.get(userId);
    if (userId === "" || user === undefined || seen.has(userId)) {
      continue;
    }

    seen.add(userId);
    targets.push(user);
  }

  return targets;
}

function isQueueBusy(queue: UnfollowQueue): boolean {
  return queue.status === "running" || queue.items.some((item) => item.status === "in-flight");
}

function isCoolingDown(queue: UnfollowQueue, now: number): boolean {
  return queue.cooldownUntil !== null && queue.cooldownUntil > now;
}

/**
 * Opens a session for the signed-in account.
 *
 * Rejections do not touch state: nothing is half-started, and the caller reports
 * the reason. Quota history survives the restart (purged to 24 hours) so a
 * restart cannot be used to reset the hourly or daily caps; only the *session*
 * counter starts over, which is what an explicit user start means.
 */
export function startQueue(
  state: ExtensionState,
  userIds: string[],
  now: number,
): StartQueueResult {
  const account = state.session.account;
  if (account === null) {
    return { ok: false, reason: "auth-required" };
  }

  if (isSyncBlockingQueue(state.syncMeta)) {
    return { ok: false, reason: "sync-running" };
  }

  const queue = state.unfollowQueue;
  if (isQueueBusy(queue)) {
    return { ok: false, reason: "queue-active" };
  }

  if (isCoolingDown(queue, now)) {
    return { ok: false, reason: "cooldown" };
  }

  const targets = selectQueueTargets(state, userIds);
  if (targets.length === 0) {
    return { ok: false, reason: "no-candidates" };
  }

  return {
    ok: true,
    state: {
      ...state,
      unfollowQueue: {
        status: "running",
        items: targets.map((target) => ({
          userId: target.userId,
          handle: target.handle,
          status: "pending",
          attempts: 0,
          lastCode: null,
        })),
        cursor: 0,
        // The first action is scheduled by the first tick, so opening the panel
        // can never trigger an immediate burst.
        nextAt: null,
        sessionStartedAt: now,
        actionTimestamps: purgeExpiredTimestamps(queue.actionTimestamps, now),
        cooldownUntil: null,
        pauseReason: null,
        consecutiveFailures: 0,
        ownerUserId: account.userId,
      },
    },
  };
}

function findIndexByStatus(
  items: UnfollowQueueItem[],
  status: UnfollowQueueItem["status"],
): number {
  return items.findIndex((item) => item.status === status);
}

function waitReason(reason: string | null): QueuePauseReason | undefined {
  switch (reason) {
    case "hourly-cap":
      return "hourly-cap";
    case "daily-cap":
      return "daily-cap";
    case "outside-active-hours":
      return "outside-active-hours";
    default:
      return undefined;
  }
}

/**
 * Decides what the queue may do at `now`. Pure, so the whole policy is testable
 * without a clock, storage, or a tab.
 *
 * `random` is injected for the interval draw. Settings are re-clamped here as
 * well: a tampered storage record can never widen the band or the caps.
 */
export function planNext(
  queue: UnfollowQueue,
  settings: Settings,
  now: number,
  random: () => number = Math.random,
): QueuePlan {
  const limits = clampSettings(settings);

  if (queue.status === "completed") {
    return { action: "complete", nextAt: null };
  }

  if (isCoolingDown(queue, now)) {
    // The alarm armed here exists only to demote the status when the window
    // closes. Leaving a breaker is a user decision, never a timer's.
    return {
      action: "wait",
      nextAt: queue.cooldownUntil,
      reason: queue.pauseReason ?? undefined,
      target: undefined,
    };
  }

  if (queue.status !== "running") {
    return {
      action: "pause",
      nextAt: null,
      reason: queue.pauseReason ?? undefined,
      target: undefined,
    };
  }

  const inFlight = findIndexByStatus(queue.items, "in-flight");
  if (inFlight !== -1) {
    // Single flight: nothing else may run until the outstanding result lands or
    // the watchdog schedule expires it.
    return {
      action: "wait",
      nextAt: queue.nextAt ?? now + pickIntervalMs(limits, random),
      target: queue.items[inFlight],
    };
  }

  const pending = findIndexByStatus(queue.items, "pending");
  const target = pending === -1 ? undefined : queue.items[pending];
  if (target === undefined) {
    return { action: "complete", nextAt: null };
  }

  const decision = canRunNext(queue, now, limits);
  if (!decision.allowed) {
    // Only the session cap needs the user: every other block clears by itself,
    // so the queue holds its place instead of ending the session.
    if (decision.reason === "session-cap") {
      return { action: "pause", nextAt: null, reason: "session-cap", target };
    }

    return {
      action: "wait",
      nextAt: decision.retryAt ?? now + pickIntervalMs(limits, random),
      reason: waitReason(decision.reason),
      target,
    };
  }

  if (queue.nextAt === null) {
    // A completed action clears the schedule; the next one always costs a full
    // freshly drawn interval, which is what stops the queue from catching up.
    return {
      action: "wait",
      nextAt: now + pickIntervalMs(limits, random),
      reason: undefined,
      target,
    };
  }

  // The `nextAt` handed out here doubles as the watchdog for the flight it
  // authorizes: if no result arrives by then, the attempt is written off.
  return { action: "execute", nextAt: now + pickIntervalMs(limits, random), target };
}

function withQueue(state: ExtensionState, patch: Partial<UnfollowQueue>): ExtensionState {
  return { ...state, unfollowQueue: { ...state.unfollowQueue, ...patch } };
}

function appendAudit(state: ExtensionState, entry: AuditEntry): AuditEntry[] {
  return [...state.auditLog, entry].slice(-MAX_AUDIT_ENTRIES);
}

/** Drops the flight without repeating it, so a pause cannot block sync forever. */
function releaseFlight(items: UnfollowQueueItem[]): UnfollowQueueItem[] {
  return items.map((item) => (item.status === "in-flight" ? { ...item, status: "skipped" } : item));
}

/**
 * A user pause is sticky: only the user may replace it, mirroring the sync
 * coordinator, so an automatic reason cannot overwrite what the user chose.
 */
function replacesPauseReason(current: QueuePauseReason | null, next: QueuePauseReason): boolean {
  return current !== next && (current !== "user" || next === "user");
}

/**
 * Pauses a working queue. `cooldownUntil` is deliberately untouched: a pause (or
 * a stop) must never become a way to shorten a breaker window.
 */
export function pauseQueue(state: ExtensionState, reason: QueuePauseReason): ExtensionState {
  const queue = state.unfollowQueue;
  if (queue.status !== "running" && queue.status !== "paused") {
    return state;
  }

  if (queue.status === "paused" && !replacesPauseReason(queue.pauseReason, reason)) {
    return state;
  }

  return withQueue(state, {
    status: "paused",
    pauseReason: reason,
    nextAt: null,
    items: releaseFlight(queue.items),
  });
}

export function stopQueue(state: ExtensionState): ExtensionState {
  const queue = state.unfollowQueue;
  if (queue.status === "idle" || queue.status === "stopped") {
    return state;
  }

  return withQueue(state, {
    status: "stopped",
    pauseReason: null,
    nextAt: null,
    items: releaseFlight(queue.items),
  });
}

/**
 * Stops the queue unless the session still belongs to the account that started
 * it. An unreadable account counts as a mismatch, and the new account is never
 * adopted: the owner recorded at start is left in place as evidence.
 */
export function enforceQueueOwner(state: ExtensionState): ExtensionState {
  const queue = state.unfollowQueue;
  if (queue.status !== "running" && queue.status !== "cooldown" && !isQueueBusy(queue)) {
    return state;
  }

  const account = state.session.account;
  if (account !== null && queue.ownerUserId !== null && account.userId === queue.ownerUserId) {
    return state;
  }

  return withQueue(stopQueue(state), { pauseReason: "account-mismatch" });
}

function auditEntry(
  item: UnfollowQueueItem,
  code: UnfollowResultCode,
  ok: boolean,
  now: number,
): AuditEntry {
  // The handle comes from stored state, never from the reported result, so the
  // log cannot be written to name a target the queue never held.
  return { at: now, userId: item.userId, handle: item.handle, ok, code };
}

interface Outcome {
  items: UnfollowQueueItem[];
  cursor: number;
}

function replaceItem(
  items: UnfollowQueueItem[],
  index: number,
  patch: Partial<UnfollowQueueItem>,
): UnfollowQueueItem[] {
  return items.map((item, position) => (position === index ? { ...item, ...patch } : item));
}

/** Applies a failed attempt: one retry for a page hiccup, otherwise a skip. */
function applyFailure(
  state: ExtensionState,
  index: number,
  code: UnfollowResultCode,
  now: number,
  retryable: boolean,
): ExtensionState {
  const queue = state.unfollowQueue;
  const item = queue.items[index];
  if (item === undefined) {
    return state;
  }

  const mayRetry = retryable && RETRYABLE_CODES.has(code) && item.attempts < MAX_ATTEMPTS_PER_ITEM;
  const outcome: Outcome = mayRetry
    ? {
        items: replaceItem(queue.items, index, { status: "pending", lastCode: code }),
        cursor: index,
      }
    : {
        items: replaceItem(queue.items, index, { status: "failed", lastCode: code }),
        cursor: index + 1,
      };

  const consecutiveFailures = queue.consecutiveFailures + 1;
  const breaker = BREAKER_REASONS.get(code);
  const streakTripped = consecutiveFailures >= FAILURE_BREAKER_THRESHOLD;

  const next: ExtensionState = {
    ...withQueue(state, {
      items: outcome.items,
      cursor: outcome.cursor,
      consecutiveFailures,
      nextAt: null,
    }),
    auditLog: appendAudit(state, auditEntry(item, code, false, now)),
  };

  if (code === "account-mismatch") {
    // A foreign session must not be retried or cooled down: it must end.
    return withQueue(stopQueue(next), { pauseReason: "account-mismatch" });
  }

  if (breaker !== undefined || streakTripped) {
    return withQueue(next, {
      status: "cooldown",
      cooldownUntil: now + COOLDOWN_MS,
      pauseReason: breaker ?? "consecutive-failures",
    });
  }

  return next;
}

function normalizeCode(code: UnfollowResultCode): UnfollowResultCode {
  // An unreadable code is treated as an unverified attempt rather than a success.
  return RESULT_CODES.has(code) ? code : "verification-failed";
}

/**
 * Records the outcome of the one outstanding attempt.
 *
 * The report comes from a content script running inside the page, so nothing in
 * it is trusted beyond the target id: the outcome is derived from the code, and
 * a report that does not match the in-flight item is dropped. The schedule is
 * cleared rather than recomputed — picking the next interval belongs to
 * `planNext`, which is the only place that draws one.
 */
export function recordResult(
  state: ExtensionState,
  result: UnfollowResult,
  now: number,
): ExtensionState {
  const queue = state.unfollowQueue;
  const userId = normalizeUserId(result.userId);
  const index = findIndexByStatus(queue.items, "in-flight");
  const item = index === -1 ? undefined : queue.items[index];
  if (item === undefined || item.userId !== userId) {
    return bookReleasedFlight(state, userId, result, now);
  }

  const code = normalizeCode(result.code);
  if (!COMPLETED_CODES.has(code)) {
    return applyFailure(state, index, code, now, true);
  }

  return {
    ...withQueue(state, {
      items: replaceItem(queue.items, index, { status: "done", lastCode: code }),
      cursor: index + 1,
      nextAt: null,
      actionTimestamps: [...purgeExpiredTimestamps(queue.actionTimestamps, now), now],
      consecutiveFailures: 0,
    }),
    auditLog: appendAudit(state, auditEntry(item, code, true, now)),
  };
}

/**
 * Books a report that arrives after a pause or a stop released its flight.
 *
 * The page may well have completed the action before the user pressed Pause, and
 * an action that happened has to cost quota and appear in the log — otherwise the
 * hourly and daily windows would undercount by one for every pause. The session
 * itself is never revived: only the item and the books are updated, which is also
 * why a duplicate report is ignored (the item is no longer `skipped`).
 */
function bookReleasedFlight(
  state: ExtensionState,
  userId: string,
  result: UnfollowResult,
  now: number,
): ExtensionState {
  const queue = state.unfollowQueue;
  const index = queue.items.findIndex(
    (entry) => entry.userId === userId && entry.status === "skipped" && entry.attempts > 0,
  );
  const item = queue.items[index];
  if (item === undefined) {
    return state;
  }

  const code = normalizeCode(result.code);
  const completed = COMPLETED_CODES.has(code);

  return {
    ...withQueue(state, {
      items: replaceItem(queue.items, index, {
        status: completed ? "done" : "failed",
        lastCode: code,
      }),
      actionTimestamps: completed
        ? [...purgeExpiredTimestamps(queue.actionTimestamps, now), now]
        : queue.actionTimestamps,
    }),
    auditLog: appendAudit(state, auditEntry(item, code, completed, now)),
  };
}

/**
 * Writes off a flight whose result never arrived.
 *
 * The watchdog is the schedule the dispatch itself persisted, so this can only
 * happen a full interval after the command was sent. The attempt is *not*
 * repeated: the worker cannot know whether the page acted, and a second click on
 * the same profile is the one thing that must not be guessed.
 */
function expireStaleFlight(state: ExtensionState, now: number): ExtensionState {
  const queue = state.unfollowQueue;
  const index = findIndexByStatus(queue.items, "in-flight");
  if (index === -1 || queue.nextAt === null || now < queue.nextAt) {
    return state;
  }

  return applyFailure(state, index, "verification-failed", now, false);
}

/** Skips queued items that stopped being candidates while the queue ran. */
function skipInvalidTargets(state: ExtensionState): ExtensionState {
  const queue = state.unfollowQueue;
  if (queue.status !== "running") {
    return state;
  }

  const allowed = new Set(
    selectCandidates(Object.values(state.following), state.whitelist).map((user) => user.userId),
  );

  let changed = false;
  const items = queue.items.map((item) => {
    if (item.status !== "pending" || allowed.has(item.userId)) {
      return item;
    }

    changed = true;

    return { ...item, status: "skipped" as const };
  });

  return changed ? withQueue(state, { items }) : state;
}

/**
 * Brings a persisted queue back to a state the worker may act on. Idempotent,
 * and it returns the input unchanged when there is nothing to repair, so the
 * caller can skip a storage write.
 */
export function reconcileQueue(state: ExtensionState, now: number): ExtensionState {
  return skipInvalidTargets(expireStaleFlight(enforceQueueOwner(state), now));
}

async function persistIfChanged(
  loaded: ExtensionState,
  mutate: (state: ExtensionState) => ExtensionState,
): Promise<ExtensionState> {
  const next = mutate(loaded);

  // The mutator runs again inside `updateState` against a freshly read snapshot;
  // every transition here is pure and idempotent, so that is safe.
  return next === loaded ? loaded : await updateState(mutate);
}

async function armAlarm(state: ExtensionState, nextAt: number): Promise<void> {
  // Order is load-bearing: a worker killed between these two lines must wake up
  // with a schedule, never with an alarm it cannot justify.
  await persistIfChanged(state, (current) =>
    current.unfollowQueue.nextAt === nextAt ? current : withQueue(current, { nextAt }),
  );
  await chrome.alarms.create(UNFOLLOW_ALARM_NAME, { when: nextAt });
}

async function clearAlarm(): Promise<void> {
  await chrome.alarms.clear(UNFOLLOW_ALARM_NAME);
}

function resolveTarget(state: ExtensionState, userId: string): FollowingUser | null {
  const user = state.following[userId];
  if (user === undefined) {
    return null;
  }

  return selectCandidates([user], state.whitelist).length === 1 ? user : null;
}

async function applyPausePlan(state: ExtensionState, plan: QueuePlan): Promise<QueuePlan> {
  const reason = plan.reason;
  if (state.unfollowQueue.status === "running" && reason !== undefined) {
    await persistIfChanged(state, (current) => pauseQueue(current, reason));
  } else if (state.unfollowQueue.status === "cooldown") {
    // The cooldown window closed: demote the status so the queue stops blocking
    // sync, while the reason stays visible until the user acts.
    await persistIfChanged(state, (current) =>
      current.unfollowQueue.status === "cooldown"
        ? withQueue(current, { status: "paused", nextAt: null })
        : current,
    );
  }

  await clearAlarm();

  return plan;
}

async function executePlan(
  state: ExtensionState,
  plan: QueuePlan,
  routeOptions: RouteOptions,
): Promise<QueuePlan> {
  const item = plan.target;
  const account = state.session.account;
  const nextAt = plan.nextAt;
  if (item === undefined || account === null || nextAt === null) {
    // `planNext` never authorizes an execution without a target, a schedule, and
    // an owner, and `reconcileQueue` has already stopped an ownerless queue. If
    // the shape is unexpected anyway, the write path closes instead of guessing.
    return await applyPausePlan(state, {
      action: "pause",
      nextAt: null,
      reason: "account-mismatch",
      target: item,
    });
  }

  const target = resolveTarget(state, item.userId);
  if (target === null) {
    // `reconcileQueue` already skips these; this is the belt to that braces.
    const skipped = await updateState(skipInvalidTargets);

    return { action: "wait", nextAt: skipped.unfollowQueue.nextAt, target: item };
  }

  const route = await routeToProfile(target.handle, routeOptions);
  if (!route.ok) {
    return await applyPausePlan(state, {
      action: "pause",
      nextAt: null,
      reason: "missing-tab",
      target: item,
    });
  }

  await updateState((current) =>
    withQueue(current, {
      nextAt,
      items: current.unfollowQueue.items.map((entry) =>
        entry.userId === item.userId && entry.status === "pending"
          ? { ...entry, status: "in-flight", attempts: entry.attempts + 1 }
          : entry,
      ),
      cursor: Math.max(
        0,
        current.unfollowQueue.items.findIndex((entry) => entry.userId === item.userId),
      ),
    }),
  );
  await chrome.alarms.create(UNFOLLOW_ALARM_NAME, { when: nextAt });

  if (await sendUnfollowOne(route.tabId, target, account)) {
    return plan;
  }

  // Nothing was clicked, so the attempt is given back and the missing content
  // context is reported instead of being counted against the target.
  const rolledBack = await updateState((current) =>
    withQueue(current, {
      items: current.unfollowQueue.items.map((entry) =>
        entry.userId === item.userId && entry.status === "in-flight"
          ? { ...entry, status: "pending", attempts: Math.max(0, entry.attempts - 1) }
          : entry,
      ),
    }),
  );

  return await applyPausePlan(rolledBack, {
    action: "pause",
    nextAt: null,
    reason: "missing-tab",
    target: item,
  });
}

/**
 * One turn of the state machine: reload, recompute, then do at most one thing.
 *
 * This is the single entry point for the alarm, for a worker restart, and for
 * everything that follows a state change, which is what makes "recompute from
 * storage" the only way the queue ever advances.
 */
export async function runQueueTick(
  now: number = Date.now(),
  random: () => number = Math.random,
  routeOptions: RouteOptions = {},
): Promise<QueuePlan> {
  const loaded = await loadState();
  const state = await persistIfChanged(loaded, (current) => reconcileQueue(current, now));
  const plan = planNext(state.unfollowQueue, state.settings, now, random);

  switch (plan.action) {
    case "execute":
      return await executePlan(state, plan, routeOptions);
    case "wait":
      if (plan.nextAt !== null) {
        await armAlarm(state, plan.nextAt);
      }

      return plan;
    case "pause":
      return await applyPausePlan(state, plan);
    case "complete":
      await persistIfChanged(state, (current) =>
        current.unfollowQueue.status === "running"
          ? withQueue(current, { status: "completed", nextAt: null, pauseReason: null })
          : current,
      );
      await clearAlarm();

      return plan;
  }
}

/**
 * Opens a session and arms the first tick. No unfollow command is sent here: the
 * first write waits for the scheduled interval, so pressing Start cannot produce
 * a burst. The write tab is brought to the first target immediately so the user
 * can see where the queue will act.
 */
export async function startUnfollowQueue(
  userIds: string[],
  now: number = Date.now(),
  random: () => number = Math.random,
  routeOptions: RouteOptions = {},
): Promise<StartUnfollowQueueResult> {
  const state = await loadState();
  const outcome = startQueue(state, userIds, now);
  if (!outcome.ok) {
    return outcome;
  }

  const previewTarget = outcome.state.unfollowQueue.items[0]?.handle;

  await updateState((current) => {
    const attempt = startQueue(current, userIds, now);

    return attempt.ok ? attempt.state : current;
  });

  if (previewTarget !== undefined) {
    void routeToProfile(previewTarget, routeOptions);
  }

  return { ok: true, plan: await runQueueTick(now, random, routeOptions) };
}

export async function pauseUnfollowQueue(reason: QueuePauseReason): Promise<void> {
  const state = await loadState();
  await persistIfChanged(state, (current) => pauseQueue(current, reason));
  await clearAlarm();
}

export async function stopUnfollowQueue(): Promise<void> {
  const state = await loadState();
  await persistIfChanged(state, stopQueue);
  await clearAlarm();
}

/**
 * Records a reported outcome, then lets the state machine decide what is next.
 * The owner check runs after the record so a result that arrives from a session
 * that just changed is still audited, but can never authorize another write.
 */
export async function applyUnfollowResult(
  result: UnfollowResult,
  now: number = Date.now(),
  random: () => number = Math.random,
  routeOptions: RouteOptions = {},
): Promise<QueuePlan> {
  await updateState((current) => enforceQueueOwner(recordResult(current, result, now)));

  return await runQueueTick(now, random, routeOptions);
}
