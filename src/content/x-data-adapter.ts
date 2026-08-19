/**
 * Version-tolerant parser for Following data that the X page loaded by itself.
 *
 * The extension never requests this data: the parser only receives payloads the
 * page had already fetched for its own rendering. X GraphQL response shapes are
 * unstable, so the traversal is structural rather than path-based — it walks the
 * payload iteratively and recognizes account objects wherever they appear.
 *
 * Two rules are load-bearing for safety:
 * 1. An absent relationship field yields `followedBy: null` ("unknown"), never
 *    `false`, because `false` is what makes an account an unfollow candidate.
 * 2. Anything that is not an unambiguous, complete account object is ignored.
 */

import { normalizeHandle, normalizeUserId } from "@/shared/rules";
import type { FollowingUser, RelationshipState } from "@/shared/types";

/**
 * Structural budget for one payload. Responses come from the page, so they are
 * untrusted input: every bound below exists to keep a hostile or pathological
 * payload from blocking the page's main thread or growing state without limit.
 */
export interface TraversalLimits {
  /** Maximum nesting level that is still descended into. */
  maxDepth: number;
  /** Maximum number of values popped from the traversal stack. */
  maxNodes: number;
  /** Maximum number of accounts collected from one payload. */
  maxUsers: number;
  /** Arrays longer than this are skipped instead of walked. */
  maxArrayLength: number;
  /** Display names are truncated to this length. */
  maxNameLength: number;
  /** Handles longer than this are rejected as malformed. */
  maxHandleLength: number;
  /** User ids longer than this are rejected as malformed. */
  maxUserIdLength: number;
  /** Avatar URLs longer than this are dropped to `null`. */
  maxAvatarUrlLength: number;
}

export const DEFAULT_TRAVERSAL_LIMITS: Readonly<TraversalLimits> = Object.freeze({
  maxDepth: 64,
  maxNodes: 200_000,
  maxUsers: 20_000,
  maxArrayLength: 50_000,
  maxNameLength: 200,
  maxHandleLength: 20,
  maxUserIdLength: 32,
  maxAvatarUrlLength: 2_048,
});

type PlainObject = Record<string, unknown>;

interface StackEntry {
  value: unknown;
  depth: number;
}

/** Handles are lowercase alphanumerics and underscores once normalized. */
const HANDLE_PATTERN = /^[a-z0-9_]+$/;
/** Ids are opaque tokens; only their character class and length are validated. */
const USER_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const HTTPS_URL_PATTERN = /^https:\/\/\S+$/i;

/** Container `__typename` / `itemType` / `entryType` values that carry no account. */
const IGNORED_TYPES = new Set([
  "TimelineTombstone",
  "TimelineTimelineTombstone",
  "TimelineTimelineCursor",
  "UserUnavailable",
]);

/** Keys that may hold a timeline nested inside an already recognized account. */
const NESTED_TIMELINE_KEYS = ["timeline", "timeline_v2"] as const;

/**
 * Collects every account described by a page-loaded payload.
 *
 * The traversal is iterative on purpose: a recursive walk over an untrusted,
 * deeply nested payload can overflow the page's stack.
 */
export function extractFollowingUsers(
  payload: unknown,
  now = Date.now(),
  limits: Partial<TraversalLimits> = {},
): FollowingUser[] {
  const budget: TraversalLimits = { ...DEFAULT_TRAVERSAL_LIMITS, ...limits };
  const found = new Map<string, FollowingUser>();
  const visited = new WeakSet<object>();
  const stack: StackEntry[] = [{ value: payload, depth: 0 }];
  let nodes = 0;

  while (stack.length > 0) {
    if (nodes >= budget.maxNodes || found.size >= budget.maxUsers) {
      break;
    }

    const entry = stack.pop();
    if (entry === undefined) {
      break;
    }

    nodes += 1;
    const { value, depth } = entry;

    if (typeof value !== "object" || value === null || depth > budget.maxDepth) {
      continue;
    }

    // Cycles are impossible in parsed JSON but not in a live page object.
    if (visited.has(value)) {
      continue;
    }
    visited.add(value);

    if (Array.isArray(value)) {
      if (value.length <= budget.maxArrayLength) {
        pushValues(stack, value, depth + 1);
      }
      continue;
    }

    // Class instances, `Map`, `Set` and other exotic objects never appear in a
    // JSON response, so they are not walked.
    if (!isPlainObject(value) || isIgnoredContainer(value)) {
      continue;
    }

    const userLike = looksLikeUser(value);
    if (userLike && pushNestedTimelines(stack, value, depth + 1)) {
      // `data.user.result` owns the Following timeline but is not itself a
      // Following edge, even when the profile owner has complete identity.
      continue;
    }

    const user = userLike ? normalizeUser(value, now, budget) : null;
    if (user !== null) {
      collect(found, user);
      continue;
    }

    // An incomplete account wrapper (for example `data.user.result`, which is
    // typed as a user but only carries the timeline) must still be descended.
    pushValues(stack, Object.values(value), depth + 1);
  }

  return [...found.values()];
}

function pushValues(stack: StackEntry[], values: readonly unknown[], depth: number): void {
  // Pushed in reverse so that popping preserves document order.
  for (let index = values.length - 1; index >= 0; index -= 1) {
    stack.push({ value: values[index], depth });
  }
}

function pushNestedTimelines(stack: StackEntry[], user: PlainObject, depth: number): boolean {
  let pushed = false;

  for (const key of NESTED_TIMELINE_KEYS) {
    const nested = readObject(user, key);
    if (nested !== null) {
      stack.push({ value: nested, depth });
      pushed = true;
    }
  }

  return pushed;
}

function isPlainObject(value: object): value is PlainObject {
  const prototype = Object.getPrototypeOf(value);

  return prototype === Object.prototype || prototype === null;
}

function hasOwn(value: PlainObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function readString(value: PlainObject, key: string): string | null {
  if (!hasOwn(value, key)) {
    return null;
  }

  const candidate = value[key];

  return typeof candidate === "string" ? candidate : null;
}

function readObject(value: PlainObject, key: string): PlainObject | null {
  if (!hasOwn(value, key)) {
    return null;
  }

  const candidate = value[key];
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    return null;
  }

  return isPlainObject(candidate) ? candidate : null;
}

function readBoolean(value: PlainObject | null, key: string): boolean | null {
  if (value === null || !hasOwn(value, key)) {
    return null;
  }

  const candidate = value[key];

  return typeof candidate === "boolean" ? candidate : null;
}

/**
 * Recognizes containers that must not be descended into: tombstones and
 * unavailable accounts (no usable relationship), cursors (pagination tokens),
 * and promoted entries (accounts the user does not follow).
 */
function isIgnoredContainer(value: PlainObject): boolean {
  if (hasOwn(value, "promotedMetadata") || hasOwn(value, "tombstone")) {
    return true;
  }

  const entryId = readString(value, "entryId");
  if (entryId !== null && entryId.startsWith("promoted-")) {
    return true;
  }

  for (const key of ["__typename", "itemType", "entryType"]) {
    const marker = readString(value, key);
    if (marker !== null && IGNORED_TYPES.has(marker)) {
      return true;
    }
  }

  return false;
}

/**
 * Whether an object claims to describe an account. Claiming is not enough to be
 * collected — `normalizeUser` still requires a usable id and handle.
 */
function looksLikeUser(value: PlainObject): boolean {
  if (readString(value, "__typename") === "User") {
    return true;
  }

  const hasId = readString(value, "rest_id") !== null || readString(value, "id_str") !== null;
  if (!hasId) {
    return false;
  }

  return (
    readString(value, "screen_name") !== null ||
    readString(readObject(value, "core") ?? {}, "screen_name") !== null ||
    readString(readObject(value, "legacy") ?? {}, "screen_name") !== null
  );
}

function normalizeUser(
  raw: PlainObject,
  now: number,
  budget: TraversalLimits,
): FollowingUser | null {
  const userId = readUserId(raw, budget);
  if (userId === null) {
    return null;
  }

  const handle = readHandle(raw, budget);
  if (handle === null) {
    return null;
  }

  return {
    userId,
    handle,
    name: readName(raw, budget),
    avatarUrl: readAvatarUrl(raw, budget),
    followedBy: readFollowedBy(raw),
    isBlueVerified: readIsBlueVerified(raw),
    protected: readProtected(raw),
    statusesCount: readStatusesCount(raw),
    friendsCount: readFriendsCount(raw),
    followersCount: readFollowersCount(raw),
    syncedAt: now,
  };
}

function readUserId(raw: PlainObject, budget: TraversalLimits): string | null {
  const legacy = readObject(raw, "legacy");
  const candidates = [
    readString(raw, "rest_id"),
    readString(raw, "id_str"),
    legacy === null ? null : readString(legacy, "id_str"),
  ];

  for (const candidate of candidates) {
    if (candidate === null) {
      continue;
    }

    const userId = normalizeUserId(candidate);
    if (userId !== "" && userId.length <= budget.maxUserIdLength && USER_ID_PATTERN.test(userId)) {
      return userId;
    }
  }

  return null;
}

function readHandle(raw: PlainObject, budget: TraversalLimits): string | null {
  const core = readObject(raw, "core");
  const legacy = readObject(raw, "legacy");
  const candidates = [
    core === null ? null : readString(core, "screen_name"),
    legacy === null ? null : readString(legacy, "screen_name"),
    readString(raw, "screen_name"),
  ];

  for (const candidate of candidates) {
    if (candidate === null) {
      continue;
    }

    const handle = normalizeHandle(candidate);
    if (handle !== "" && handle.length <= budget.maxHandleLength && HANDLE_PATTERN.test(handle)) {
      return handle;
    }
  }

  return null;
}

/** A missing display name is not fatal: the handle already identifies the account. */
function readName(raw: PlainObject, budget: TraversalLimits): string {
  const core = readObject(raw, "core");
  const legacy = readObject(raw, "legacy");
  const candidates = [
    core === null ? null : readString(core, "name"),
    legacy === null ? null : readString(legacy, "name"),
    readString(raw, "name"),
  ];

  for (const candidate of candidates) {
    const name = candidate?.trim() ?? "";
    if (name !== "") {
      return name.slice(0, budget.maxNameLength);
    }
  }

  return "";
}

/** Only absolute https URLs are kept, so no page-supplied scheme can be rendered. */
function readAvatarUrl(raw: PlainObject, budget: TraversalLimits): string | null {
  const avatar = readObject(raw, "avatar");
  const legacy = readObject(raw, "legacy");
  const candidates = [
    avatar === null ? null : readString(avatar, "image_url"),
    legacy === null ? null : readString(legacy, "profile_image_url_https"),
    readString(raw, "profile_image_url_https"),
  ];

  for (const candidate of candidates) {
    if (candidate === null) {
      continue;
    }

    const url = candidate.trim();
    if (url.length <= budget.maxAvatarUrlLength && HTTPS_URL_PATTERN.test(url)) {
      return url;
    }
  }

  return null;
}

/**
 * Relationship direction as reported by the page. The modern
 * `relationship_perspectives` block wins over the legacy field, and any
 * non-boolean value is treated as unknown.
 */
function readFollowedBy(raw: PlainObject): RelationshipState {
  const perspectives = readBoolean(readObject(raw, "relationship_perspectives"), "followed_by");
  if (perspectives !== null) {
    return perspectives;
  }

  return readBoolean(readObject(raw, "legacy"), "followed_by");
}

function readTriStateBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function readNonNegativeInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return Math.floor(value);
}

function readIsBlueVerified(raw: PlainObject): boolean | null {
  return readTriStateBoolean(raw.is_blue_verified);
}

function readProtected(raw: PlainObject): boolean | null {
  const legacy = readObject(raw, "legacy");
  const fromLegacy = legacy === null ? null : readTriStateBoolean(legacy.protected);
  if (fromLegacy !== null) {
    return fromLegacy;
  }
  return readTriStateBoolean(raw.protected);
}

function readStatusesCount(raw: PlainObject): number | null {
  const legacy = readObject(raw, "legacy");
  return legacy === null ? null : readNonNegativeInt(legacy.statuses_count);
}

function readFriendsCount(raw: PlainObject): number | null {
  const legacy = readObject(raw, "legacy");
  return legacy === null ? null : readNonNegativeInt(legacy.friends_count);
}

function readFollowersCount(raw: PlainObject): number | null {
  const legacy = readObject(raw, "legacy");
  return legacy === null ? null : readNonNegativeInt(legacy.followers_count);
}

/**
 * Deduplicates by user id. The first occurrence wins and later duplicates only
 * fill gaps, so a repeated entry can never downgrade an already known
 * relationship, name, or avatar.
 */
function collect(found: Map<string, FollowingUser>, user: FollowingUser): void {
  const existing = found.get(user.userId);
  if (existing === undefined) {
    found.set(user.userId, user);
    return;
  }

  found.set(user.userId, {
    ...existing,
    name: existing.name === "" ? user.name : existing.name,
    avatarUrl: existing.avatarUrl ?? user.avatarUrl,
    followedBy: existing.followedBy ?? user.followedBy,
    isBlueVerified: existing.isBlueVerified ?? user.isBlueVerified,
    protected: existing.protected ?? user.protected,
    statusesCount: existing.statusesCount ?? user.statusesCount,
    friendsCount: existing.friendsCount ?? user.friendsCount,
    followersCount: existing.followersCount ?? user.followersCount,
  });
}
