/**
 * Trust boundary for Following records that originate in the page.
 *
 * The MAIN world already shapes payloads into `FollowingUser` objects, but that
 * world runs the page's own JavaScript: everything it posts is untrusted input.
 * Every record that crosses into the extension passes through here, in the
 * ISOLATED world and again in the service worker, so a compromised or simply
 * buggy page cannot write anything the extension would not write itself.
 *
 * Three rules are load-bearing:
 *
 * 1. `syncedAt` is always re-stamped with the caller's clock. A page-supplied
 *    timestamp could be far in the future and would then win every merge in
 *    `applyFollowingBatch` forever.
 * 2. `followedBy` stays `null` unless the value is a real boolean. `false` is
 *    what makes an account an unfollow candidate, so it is never inferred.
 * 3. Only the six known fields survive; nothing the page attached is forwarded.
 */

import { normalizeHandle, normalizeUserId } from "./rules";
import type { FollowingUser, RelationshipState } from "./types";

export interface FollowingBatchLimits {
  /** Batches above this size are rejected whole, never truncated. */
  maxUsers: number;
  maxUserIdLength: number;
  maxHandleLength: number;
  maxNameLength: number;
  maxAvatarUrlLength: number;
}

/**
 * `maxUsers` matches the MAIN-world chunk size, so a legitimate message always
 * fits and anything larger is a malformed or hostile batch.
 */
export const DEFAULT_FOLLOWING_BATCH_LIMITS: Readonly<FollowingBatchLimits> = Object.freeze({
  maxUsers: 500,
  maxUserIdLength: 32,
  maxHandleLength: 20,
  maxNameLength: 200,
  maxAvatarUrlLength: 2_048,
});

/** Handles are lowercase alphanumerics and underscores once normalized. */
const HANDLE_PATTERN = /^[a-z0-9_]+$/;
/** Ids are opaque tokens; only their character class and length are validated. */
const USER_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const HTTPS_URL_PATTERN = /^https:\/\/\S+$/i;

/**
 * Returns the records that may enter extension state, keyed order preserved.
 *
 * A batch that is not an array, or that exceeds `maxUsers`, is rejected as a
 * whole; individual records that cannot be repaired are dropped. Duplicates are
 * resolved in favour of the first occurrence, mirroring the MAIN-world parser.
 */
export function validateFollowingUsers(
  value: unknown,
  now: number,
  limits: Partial<FollowingBatchLimits> = {},
): FollowingUser[] {
  const budget: FollowingBatchLimits = { ...DEFAULT_FOLLOWING_BATCH_LIMITS, ...limits };
  if (!Array.isArray(value) || value.length > budget.maxUsers) {
    return [];
  }

  const syncedAt = Number.isFinite(now) ? now : 0;
  const users = new Map<string, FollowingUser>();

  for (const entry of value) {
    const user = normalizeRecord(entry, syncedAt, budget);
    if (user !== null && !users.has(user.userId)) {
      users.set(user.userId, user);
    }
  }

  return [...users.values()];
}

function normalizeRecord(
  value: unknown,
  syncedAt: number,
  budget: FollowingBatchLimits,
): FollowingUser | null {
  if (!isRecord(value)) {
    return null;
  }

  const userId = readUserId(value.userId, budget);
  if (userId === null) {
    return null;
  }

  const handle = readHandle(value.handle, budget);
  if (handle === null) {
    return null;
  }

  return {
    userId,
    handle,
    name: readName(value.name, budget),
    avatarUrl: readAvatarUrl(value.avatarUrl, budget),
    followedBy: readFollowedBy(value.followedBy),
    syncedAt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  // Exotic objects (`Map`, class instances, proxies) never come from JSON.
  const prototype = Object.getPrototypeOf(value);

  return prototype === Object.prototype || prototype === null;
}

function readUserId(value: unknown, budget: FollowingBatchLimits): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const userId = normalizeUserId(value);

  return userId !== "" && userId.length <= budget.maxUserIdLength && USER_ID_PATTERN.test(userId)
    ? userId
    : null;
}

function readHandle(value: unknown, budget: FollowingBatchLimits): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const handle = normalizeHandle(value);

  return handle !== "" && handle.length <= budget.maxHandleLength && HANDLE_PATTERN.test(handle)
    ? handle
    : null;
}

/** A missing display name is not fatal: the handle already identifies the account. */
function readName(value: unknown, budget: FollowingBatchLimits): string {
  return typeof value === "string" ? value.trim().slice(0, budget.maxNameLength) : "";
}

/** Only absolute https URLs survive, so no page-supplied scheme can be rendered. */
function readAvatarUrl(value: unknown, budget: FollowingBatchLimits): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const url = value.trim();

  return url.length <= budget.maxAvatarUrlLength && HTTPS_URL_PATTERN.test(url) ? url : null;
}

function readFollowedBy(value: unknown): RelationshipState {
  return typeof value === "boolean" ? value : null;
}
