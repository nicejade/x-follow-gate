import { normalizeHandle, selectCandidates } from "@/shared/rules";
import type { FollowingUser, RelationshipState } from "@/shared/types";

function user(userId: string, handle: string, followedBy: RelationshipState): FollowingUser {
  return {
    userId,
    handle,
    name: `Name ${userId}`,
    avatarUrl: null,
    followedBy,
    syncedAt: 1_700_000_000_000,
  };
}

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

describe("selectCandidates", () => {
  it("selects only explicit non-followers not on the whitelist", () => {
    const users = [
      user("1", "mutual", true),
      user("2", "candidate", false),
      user("3", "protected", false),
      user("4", "unknown", null),
    ];

    expect(selectCandidates(users, [{ userId: "3" }]).map((item) => item.userId)).toEqual(["2"]);
  });

  it("never treats an unknown relationship as a non-follower", () => {
    const users = [user("10", "unknown-a", null), user("11", "unknown-b", null)];

    expect(selectCandidates(users, [])).toEqual([]);
  });

  it("excludes whitelisted handles regardless of @ prefix and letter case", () => {
    const users = [user("1", "alice", false), user("2", "bob", false)];

    expect(selectCandidates(users, [{ handle: "@ALICE" }]).map((item) => item.userId)).toEqual([
      "2",
    ]);
  });

  it("matches whitelist entries by user id or handle", () => {
    const users = [user("1", "alice", false), user("2", "bob", false), user("3", "carol", false)];

    const whitelist = [{ userId: "1" }, { handle: "carol" }];

    expect(selectCandidates(users, whitelist).map((item) => item.userId)).toEqual(["2"]);
  });

  it("matches whitelisted user ids with surrounding whitespace on either side", () => {
    const users = [user(" 1 ", "alice", false), user("2", "bob", false), user("3", "carol", false)];

    const whitelist = [{ userId: "1" }, { userId: " 3 " }];

    expect(selectCandidates(users, whitelist).map((item) => item.userId)).toEqual(["2"]);
  });

  it("ignores empty whitelist entries so they cannot exclude every user", () => {
    const users = [user("1", "alice", false), user("2", "", false)];

    const whitelist = [{}, { handle: "  " }, { userId: "" }];

    expect(selectCandidates(users, whitelist).map((item) => item.userId)).toEqual(["1", "2"]);
  });

  it("preserves input order and returns the original user objects", () => {
    const first = user("9", "nine", false);
    const second = user("8", "eight", false);

    const result = selectCandidates([first, second], []);

    expect(result).toEqual([first, second]);
    expect(result[0]).toBe(first);
  });

  it("returns an empty list when there is nothing to clean up", () => {
    expect(selectCandidates([], [])).toEqual([]);
  });
});
