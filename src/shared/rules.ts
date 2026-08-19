/**
 * Pure candidate logic driven by enabled scan strategies.
 *
 * A user enters the unfollow queue when at least one enabled strategy matches
 * and the user is not whitelisted. Unknown/null profile fields never match.
 */

import { DEFAULT_SCAN_STRATEGIES } from "./defaults";
import type {
  FollowingUser,
  ScanStrategyId,
  ScanStrategies,
  WhitelistEntry,
} from "./types";

export const LOW_TWEET_COUNT_THRESHOLD = 10;
export const FOLLOW_RATIO_MIN_FOLLOWING = 100;
export const FOLLOW_RATIO_MULTIPLIER = 1.2;

export const SCAN_STRATEGY_LABELS: Record<ScanStrategyId, string> = {
  "not-following-back": "未回关",
  "non-blue-verified": "非蓝标",
  protected: "已锁定",
  "low-tweet-count": "推文<10",
  "follow-ratio": "关注/粉丝比",
};

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

function matchesFollowRatio(user: FollowingUser): boolean {
  const { friendsCount, followersCount } = user;
  if (friendsCount === null || followersCount === null) {
    return false;
  }
  if (friendsCount < FOLLOW_RATIO_MIN_FOLLOWING) {
    return false;
  }
  return friendsCount >= followersCount * FOLLOW_RATIO_MULTIPLIER;
}

export function matchReasons(
  user: FollowingUser,
  strategies: ScanStrategies = DEFAULT_SCAN_STRATEGIES,
): ScanStrategyId[] {
  const reasons: ScanStrategyId[] = [];

  if (strategies.notFollowingBack && user.followedBy === false) {
    reasons.push("not-following-back");
  }
  if (strategies.nonBlueVerified && user.isBlueVerified === false) {
    reasons.push("non-blue-verified");
  }
  if (strategies.protected && user.protected === true) {
    reasons.push("protected");
  }
  if (
    strategies.lowTweetCount &&
    user.statusesCount !== null &&
    user.statusesCount < LOW_TWEET_COUNT_THRESHOLD
  ) {
    reasons.push("low-tweet-count");
  }
  if (strategies.followRatio && matchesFollowRatio(user)) {
    reasons.push("follow-ratio");
  }

  return reasons;
}

/**
 * Returns the users that may enter the unfollow queue, preserving input order.
 */
export function selectCandidates(
  users: FollowingUser[],
  whitelist: WhitelistEntry[],
  strategies: ScanStrategies = DEFAULT_SCAN_STRATEGIES,
): FollowingUser[] {
  const index = buildWhitelistIndex(whitelist);

  return users.filter(
    (user) => !matchesIndex(user, index) && matchReasons(user, strategies).length > 0,
  );
}
