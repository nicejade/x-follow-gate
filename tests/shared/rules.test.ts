import { DEFAULT_SCAN_STRATEGIES } from "@/shared/defaults";
import {
  FOLLOW_RATIO_MIN_FOLLOWING,
  FOLLOW_RATIO_MULTIPLIER,
  LOW_TWEET_COUNT_THRESHOLD,
  matchReasons,
  normalizeHandle,
  selectCandidates,
} from "@/shared/rules";
import type { FollowingUser, RelationshipState, ScanStrategies } from "@/shared/types";

function user(
  userId: string,
  handle: string,
  followedBy: RelationshipState,
  overrides: Partial<FollowingUser> = {},
): FollowingUser {
  return {
    userId,
    handle,
    name: `Name ${userId}`,
    avatarUrl: null,
    followedBy,
    isBlueVerified: null,
    protected: null,
    statusesCount: null,
    friendsCount: null,
    followersCount: null,
    syncedAt: 1_700_000_000_000,
    ...overrides,
  };
}

const P0_ONLY: ScanStrategies = { ...DEFAULT_SCAN_STRATEGIES };
const ALL_OFF: ScanStrategies = {
  notFollowingBack: false,
  nonBlueVerified: false,
  protected: false,
  lowTweetCount: false,
  followRatio: false,
};

describe("normalizeHandle", () => {
  it("removes the leading @ and lowercases", () => {
    expect(normalizeHandle("@Alice")).toBe("alice");
    expect(normalizeHandle("  @BOB  ")).toBe("bob");
    expect(normalizeHandle("Carol")).toBe("carol");
  });

  it("returns an empty string for blank input", () => {
    expect(normalizeHandle("")).toBe("");
    expect(normalizeHandle("   ")).toBe("");
    expect(normalizeHandle("@")).toBe("");
  });
});

describe("matchReasons", () => {
  it("matches not-following-back only when followedBy is false", () => {
    const strategies = { ...ALL_OFF, notFollowingBack: true };
    expect(matchReasons(user("1", "a", false), strategies)).toEqual(["not-following-back"]);
    expect(matchReasons(user("2", "b", true), strategies)).toEqual([]);
    expect(matchReasons(user("3", "c", null), strategies)).toEqual([]);
  });

  it("matches non-blue-verified only when isBlueVerified is false", () => {
    const strategies = { ...ALL_OFF, nonBlueVerified: true };
    expect(matchReasons(user("1", "a", true, { isBlueVerified: false }), strategies)).toEqual([
      "non-blue-verified",
    ]);
    expect(matchReasons(user("2", "b", true, { isBlueVerified: true }), strategies)).toEqual([]);
    expect(matchReasons(user("3", "c", true, { isBlueVerified: null }), strategies)).toEqual([]);
  });

  it("matches protected only when protected is true", () => {
    const strategies = { ...ALL_OFF, protected: true };
    expect(matchReasons(user("1", "a", true, { protected: true }), strategies)).toEqual([
      "protected",
    ]);
    expect(matchReasons(user("2", "b", false, { protected: false }), strategies)).toEqual([]);
    expect(matchReasons(user("3", "c", false, { protected: null }), strategies)).toEqual([]);
  });

  it("matches low-tweet-count when statusesCount is below threshold", () => {
    const strategies = { ...ALL_OFF, lowTweetCount: true };
    expect(
      matchReasons(
        user("1", "a", true, { statusesCount: LOW_TWEET_COUNT_THRESHOLD - 1 }),
        strategies,
      ),
    ).toEqual(["low-tweet-count"]);
    expect(
      matchReasons(user("2", "b", true, { statusesCount: LOW_TWEET_COUNT_THRESHOLD }), strategies),
    ).toEqual([]);
    expect(matchReasons(user("3", "c", true, { statusesCount: null }), strategies)).toEqual([]);
  });

  it("matches follow-ratio at the 1.2x boundary with minimum following", () => {
    const strategies = { ...ALL_OFF, followRatio: true };
    const belowMin = user("1", "a", true, {
      friendsCount: FOLLOW_RATIO_MIN_FOLLOWING - 1,
      followersCount: 1,
    });
    const exact = user("2", "b", true, {
      friendsCount: FOLLOW_RATIO_MIN_FOLLOWING,
      followersCount: Math.floor(FOLLOW_RATIO_MIN_FOLLOWING / FOLLOW_RATIO_MULTIPLIER),
    });
    const match = user("3", "c", true, {
      friendsCount: 200,
      followersCount: 100,
    });
    expect(matchReasons(belowMin, strategies)).toEqual([]);
    expect(matchReasons(exact, strategies)).toEqual(["follow-ratio"]);
    expect(matchReasons(match, strategies)).toEqual(["follow-ratio"]);
    expect(
      matchReasons(user("4", "d", true, { friendsCount: 200, followersCount: null }), strategies),
    ).toEqual([]);
  });

  it("returns multiple reasons when several enabled strategies match", () => {
    const strategies = { ...ALL_OFF, notFollowingBack: true, nonBlueVerified: true };
    expect(
      matchReasons(user("1", "a", false, { isBlueVerified: false }), strategies),
    ).toEqual(["not-following-back", "non-blue-verified"]);
  });
});

describe("selectCandidates", () => {
  it("selects only explicit non-followers not on the whitelist", () => {
    const users = [
      user("1", "mutual", true),
      user("2", "candidate", false),
      user("3", "protected", false),
      user("4", "unknown", null),
    ];

    expect(selectCandidates(users, [{ userId: "3" }], P0_ONLY).map((item) => item.userId)).toEqual([
      "2",
    ]);
  });

  it("never treats an unknown relationship as a non-follower", () => {
    const users = [user("10", "unknown-a", null), user("11", "unknown-b", null)];

    expect(selectCandidates(users, [], P0_ONLY)).toEqual([]);
  });

  it("excludes whitelisted handles regardless of @ prefix and letter case", () => {
    const users = [user("1", "alice", false), user("2", "bob", false)];

    expect(
      selectCandidates(users, [{ handle: "@ALICE" }], P0_ONLY).map((item) => item.userId),
    ).toEqual(["2"]);
  });

  it("matches whitelist entries by user id or handle", () => {
    const users = [user("1", "alice", false), user("2", "bob", false), user("3", "carol", false)];

    const whitelist = [{ userId: "1" }, { handle: "carol" }];

    expect(selectCandidates(users, whitelist, P0_ONLY).map((item) => item.userId)).toEqual(["2"]);
  });

  it("matches whitelisted user ids with surrounding whitespace on either side", () => {
    const users = [user("1", "alice", false), user("2", "bob", false), user("3", "carol", false)];

    const whitelist = [{ userId: "1" }, { userId: " 3 " }];

    expect(selectCandidates(users, whitelist, P0_ONLY).map((item) => item.userId)).toEqual(["2"]);
  });

  it("ignores empty whitelist entries so they cannot exclude every user", () => {
    const users = [user("1", "alice", false), user("2", "", false)];

    const whitelist = [{}, { handle: "  " }, { userId: "" }];

    expect(selectCandidates(users, whitelist, P0_ONLY).map((item) => item.userId)).toEqual([
      "1",
      "2",
    ]);
  });

  it("preserves input order and returns the original user objects", () => {
    const first = user("9", "nine", false);
    const second = user("8", "eight", false);

    const result = selectCandidates([first, second], [], P0_ONLY);

    expect(result).toEqual([first, second]);
    expect(result[0]).toBe(first);
  });

  it("returns an empty list when there is nothing to clean up", () => {
    expect(selectCandidates([], [], P0_ONLY)).toEqual([]);
  });
});

describe("selectCandidates with strategies", () => {
  it("preserves P0 behavior when only notFollowingBack is enabled", () => {
    const users = [
      user("1", "mutual", true),
      user("2", "candidate", false),
      user("3", "protected", false),
      user("4", "unknown", null),
    ];
    expect(
      selectCandidates(users, [{ userId: "3" }], P0_ONLY).map((item) => item.userId),
    ).toEqual(["2"]);
  });

  it("OR-combines enabled strategies", () => {
    const users = [
      user("1", "mutual-blue", true, { isBlueVerified: true }),
      user("2", "mutual-nonblue", true, { isBlueVerified: false }),
      user("3", "nf-nonblue", false, { isBlueVerified: false }),
    ];
    const strategies = { ...ALL_OFF, nonBlueVerified: true };
    expect(selectCandidates(users, [], strategies).map((item) => item.userId)).toEqual([
      "2",
      "3",
    ]);
  });

  it("returns empty when all strategies are disabled", () => {
    expect(selectCandidates([user("1", "a", false)], [], ALL_OFF)).toEqual([]);
  });

  it("still excludes whitelisted users across strategies", () => {
    const users = [user("1", "a", false, { isBlueVerified: false })];
    const strategies = { ...ALL_OFF, notFollowingBack: true, nonBlueVerified: true };
    expect(selectCandidates(users, [{ handle: "a" }], strategies)).toEqual([]);
  });
});
