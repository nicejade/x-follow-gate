/**
 * Pure P0 candidate logic.
 *
 * A user is an unfollow candidate only when the relationship is explicitly
 * "does not follow back" and the user is not whitelisted.
 */

import type { FollowingUser, WhitelistEntry } from "./types";

/** Normalizes a handle to lowercase without the leading `@`. */
export function normalizeHandle(handle: string): string {
  if (typeof handle !== "string") {
    return "";
  }

  return handle.trim().replace(/^@+/, "").trim().toLowerCase();
}

/** Trims a user id so stored and whitelisted ids compare symmetrically. */
export function normalizeUserId(userId: string): string {
  return typeof userId === "string" ? userId.trim() : "";
}

interface WhitelistIndex {
  userIds: Set<string>;
  handles: Set<string>;
}

function buildWhitelistIndex(whitelist: WhitelistEntry[]): WhitelistIndex {
  const userIds = new Set<string>();
  const handles = new Set<string>();

  for (const entry of whitelist) {
    const userId = normalizeUserId(entry?.userId ?? "");
    if (userId) {
      userIds.add(userId);
    }

    const handle = normalizeHandle(entry?.handle ?? "");
    if (handle) {
      handles.add(handle);
    }
  }

  return { userIds, handles };
}

export function isWhitelisted(user: FollowingUser, whitelist: WhitelistEntry[]): boolean {
  return matchesIndex(user, buildWhitelistIndex(whitelist));
}

function matchesIndex(user: FollowingUser, index: WhitelistIndex): boolean {
  const userId = normalizeUserId(user.userId);
  if (userId !== "" && index.userIds.has(userId)) {
    return true;
  }

  const handle = normalizeHandle(user.handle);
  return handle !== "" && index.handles.has(handle);
}

/**
 * Returns the users that may enter the unfollow queue, preserving input order.
 * An unknown relationship (`null`) is never a candidate.
 */
export function selectCandidates(
  users: FollowingUser[],
  whitelist: WhitelistEntry[],
): FollowingUser[] {
  const index = buildWhitelistIndex(whitelist);

  return users.filter((user) => user.followedBy === false && !matchesIndex(user, index));
}
