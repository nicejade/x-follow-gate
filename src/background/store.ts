/**
 * The only gateway to persisted extension state.
 *
 * `chrome.storage.local` is the single source of truth because the MV3 service
 * worker can be terminated between any two events. Two rules follow from that:
 *
 * 1. Every operation re-reads persisted state instead of trusting an in-memory
 *    snapshot; the update chain below only prevents overlap within one worker
 *    lifetime.
 * 2. Nothing is written without passing through `clampSettings`, so a corrupted
 *    or tampered record can never persist limits above the P0 safety floors.
 */

import { createDefaultState, STATE_STORAGE_KEY, STATE_VERSION } from "@/shared/defaults";
import { normalizeHandle, normalizeUserId, selectCandidates } from "@/shared/rules";
import { clampSettings } from "@/shared/safety";
import type {
  AuditEntry,
  ExtensionState,
  FollowingUser,
  Settings,
  SessionState,
  SyncMeta,
  UnfollowQueue,
  WhitelistEntry,
} from "@/shared/types";

/**
 * Serializes write operations issued during a single worker lifetime. Chain
 * failures are swallowed so one rejected mutator cannot block later writes.
 */
let updateChain: Promise<void> = Promise.resolve();

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = updateChain.then(operation);
  updateChain = result.then(
    () => undefined,
    () => undefined,
  );

  return result;
}

export async function loadState(): Promise<ExtensionState> {
  const stored = await chrome.storage.local.get(STATE_STORAGE_KEY);

  return hydrateState(stored[STATE_STORAGE_KEY]);
}

export function replaceState(next: ExtensionState): Promise<void> {
  return enqueue(async () => {
    await persist(next);
  });
}

/**
 * Reads the persisted state, applies `mutator`, and writes the result. The
 * mutator must be pure: it may be called only after the previous queued write
 * settled, and its input is a freshly hydrated snapshot.
 */
export function updateState(
  mutator: (current: ExtensionState) => ExtensionState,
): Promise<ExtensionState> {
  return enqueue(async () => {
    const current = await loadState();

    return persist(mutator(current));
  });
}

/**
 * Merges a scroll batch into the following map and refreshes the candidate
 * snapshot. Records are keyed by normalized `userId`; the newest observation
 * wins, so an out-of-order batch cannot resurrect a stale relationship.
 */
export function applyFollowingBatch(state: ExtensionState, users: FollowingUser[]): ExtensionState {
  const following = { ...state.following };

  for (const incoming of users) {
    const userId = normalizeUserId(incoming.userId);
    if (userId === "") {
      continue;
    }

    const existing = following[userId];
    if (existing !== undefined && existing.syncedAt > incoming.syncedAt) {
      continue;
    }

    following[userId] = { ...incoming, userId, handle: normalizeHandle(incoming.handle) };
  }

  return recomputeCandidates({ ...state, following });
}

/**
 * Recomputes the candidate snapshot from the P0 rule: only explicit
 * non-followers that are not whitelisted. Must run after any change to the
 * following map or the whitelist.
 */
export function recomputeCandidates(state: ExtensionState): ExtensionState {
  const candidates = selectCandidates(Object.values(state.following), state.whitelist).map(
    (user) => user.userId,
  );

  return { ...state, candidates };
}

/** Removes users from the following map and refreshes the candidate snapshot. */
export function removeFollowingUsers(state: ExtensionState, userIds: string[]): ExtensionState {
  if (userIds.length === 0) {
    return state;
  }

  const following = { ...state.following };
  let changed = false;

  for (const rawId of userIds) {
    const userId = normalizeUserId(rawId);
    if (userId !== "" && following[userId] !== undefined) {
      delete following[userId];
      changed = true;
    }
  }

  return changed ? recomputeCandidates({ ...state, following }) : state;
}

async function persist(state: ExtensionState): Promise<ExtensionState> {
  const next = sanitizeState(state);
  await chrome.storage.local.set({ [STATE_STORAGE_KEY]: next });

  return next;
}

/** Last checkpoint before storage: stored limits can only ever be safe ones. */
function sanitizeState(state: ExtensionState): ExtensionState {
  return { ...state, version: STATE_VERSION, settings: clampSettings(state.settings) };
}

/**
 * Rebuilds a usable state tree from an untrusted persisted value. Missing or
 * structurally broken sections fall back to defaults instead of throwing,
 * because a worker that cannot read its state cannot stop a running queue.
 */
function hydrateState(value: unknown): ExtensionState {
  const defaults = createDefaultState();
  if (!isRecord(value)) {
    return defaults;
  }

  return {
    version: STATE_VERSION,
    session: hydrateSection<SessionState>(value.session, defaults.session),
    following: hydrateFollowing(value.following),
    syncMeta: hydrateSection<SyncMeta>(value.syncMeta, defaults.syncMeta),
    whitelist: hydrateArray<WhitelistEntry>(value.whitelist, isWhitelistEntry),
    candidates: hydrateArray<string>(value.candidates, isNonEmptyString),
    unfollowQueue: hydrateSection<UnfollowQueue>(value.unfollowQueue, defaults.unfollowQueue),
    settings: clampSettings(hydrateSection<Settings>(value.settings, defaults.settings)),
    auditLog: hydrateArray<AuditEntry>(value.auditLog, isAuditEntry),
  };
}

function hydrateSection<T extends object>(value: unknown, fallback: T): T {
  return isRecord(value) ? { ...fallback, ...(value as T) } : fallback;
}

function hydrateArray<T>(value: unknown, isValid: (item: unknown) => item is T): T[] {
  return Array.isArray(value) ? value.filter(isValid) : [];
}

/**
 * Rebuilds the following map with exactly the guarantees of the write path: the
 * key is the normalized `userId`, handles are normalized, and a record the store
 * would refuse to write today cannot re-enter through storage. Without this, a
 * corrupted or hand-edited record could reappear in the candidate snapshot.
 */
function hydrateFollowing(value: unknown): Record<string, FollowingUser> {
  if (!isRecord(value)) {
    return {};
  }

  const following: Record<string, FollowingUser> = {};
  for (const user of Object.values(value)) {
    if (!isFollowingUser(user)) {
      continue;
    }

    const userId = normalizeUserId(user.userId);
    if (userId === "") {
      continue;
    }

    following[userId] = { ...user, userId, handle: normalizeHandle(user.handle) };
  }

  return following;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

function isFollowingUser(value: unknown): value is FollowingUser {
  return (
    isRecord(value) &&
    typeof value.userId === "string" &&
    typeof value.handle === "string" &&
    typeof value.name === "string" &&
    (typeof value.avatarUrl === "string" || value.avatarUrl === null) &&
    // A non-finite timestamp would win or lose every merge unpredictably.
    Number.isFinite(value.syncedAt) &&
    // An unknown relationship stays unknown; it must never be read as `false`.
    (value.followedBy === true || value.followedBy === false || value.followedBy === null)
  );
}

function isWhitelistEntry(value: unknown): value is WhitelistEntry {
  return (
    isRecord(value) &&
    (isNonEmptyString(value.userId) || isNonEmptyString(value.handle)) &&
    (value.userId === undefined || typeof value.userId === "string") &&
    (value.handle === undefined || typeof value.handle === "string")
  );
}

function isAuditEntry(value: unknown): value is AuditEntry {
  return (
    isRecord(value) &&
    typeof value.at === "number" &&
    typeof value.userId === "string" &&
    typeof value.handle === "string" &&
    typeof value.ok === "boolean" &&
    typeof value.code === "string"
  );
}
