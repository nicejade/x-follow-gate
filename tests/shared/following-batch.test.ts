import { DEFAULT_FOLLOWING_BATCH_LIMITS, validateFollowingUsers } from "@/shared/following-batch";

/** A page-supplied timestamp must never survive the trust boundary. */
const PAGE_TIME = 1_600_000_000_000;
const TRUSTED_TIME = 1_700_000_000_000;

function pageUser(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    userId: "1",
    handle: "alice",
    name: "Alice",
    avatarUrl: "https://pbs.x.com/profile_images/alice.jpg",
    followedBy: false,
    syncedAt: PAGE_TIME,
    ...overrides,
  };
}

describe("validateFollowingUsers", () => {
  it("returns an empty batch for anything that is not an array", () => {
    for (const value of [undefined, null, "users", 7, {}, { length: 1 }]) {
      expect(validateFollowingUsers(value, TRUSTED_TIME)).toEqual([]);
    }
  });

  it("rejects a batch larger than the transport limit instead of truncating it", () => {
    const oversized = Array.from({ length: DEFAULT_FOLLOWING_BATCH_LIMITS.maxUsers + 1 }, (_, i) =>
      pageUser({ userId: `${i}`, handle: `user${i}` }),
    );

    expect(validateFollowingUsers(oversized, TRUSTED_TIME)).toEqual([]);
  });

  it("accepts a batch that sits exactly on the limit", () => {
    const batch = Array.from({ length: DEFAULT_FOLLOWING_BATCH_LIMITS.maxUsers }, (_, i) =>
      pageUser({ userId: `${i}`, handle: `user${i}` }),
    );

    expect(validateFollowingUsers(batch, TRUSTED_TIME)).toHaveLength(
      DEFAULT_FOLLOWING_BATCH_LIMITS.maxUsers,
    );
  });

  it("re-stamps every record with the trusted clock", () => {
    const users = validateFollowingUsers(
      [pageUser(), pageUser({ userId: "2", handle: "bob" })],
      TRUSTED_TIME,
    );

    expect(users.map((user) => user.syncedAt)).toEqual([TRUSTED_TIME, TRUSTED_TIME]);
  });

  it("re-stamps records whose timestamp is unusable", () => {
    const users = validateFollowingUsers(
      [
        pageUser({ userId: "1", handle: "a", syncedAt: Number.NaN }),
        pageUser({ userId: "2", handle: "b", syncedAt: Number.POSITIVE_INFINITY }),
        pageUser({ userId: "3", handle: "c", syncedAt: "1700000000000" }),
        pageUser({ userId: "4", handle: "d", syncedAt: undefined }),
      ],
      TRUSTED_TIME,
    );

    expect(users).toHaveLength(4);
    expect(users.every((user) => user.syncedAt === TRUSTED_TIME)).toBe(true);
  });

  it("normalizes ids and handles instead of trusting the page format", () => {
    const users = validateFollowingUsers(
      [pageUser({ userId: "  42  ", handle: " @Alice " })],
      TRUSTED_TIME,
    );

    expect(users[0]).toMatchObject({ userId: "42", handle: "alice" });
  });

  it("drops records without a usable user id", () => {
    const users = validateFollowingUsers(
      [
        pageUser({ userId: "" }),
        pageUser({ userId: "   " }),
        pageUser({ userId: 42 }),
        pageUser({ userId: undefined }),
        pageUser({ userId: "1 2" }),
        pageUser({ userId: "../etc" }),
        pageUser({ userId: "9".repeat(DEFAULT_FOLLOWING_BATCH_LIMITS.maxUserIdLength + 1) }),
        pageUser({ userId: "7", handle: "kept" }),
      ],
      TRUSTED_TIME,
    );

    expect(users.map((user) => user.userId)).toEqual(["7"]);
  });

  it("drops records whose handle cannot be a real handle", () => {
    const users = validateFollowingUsers(
      [
        pageUser({ userId: "1", handle: "" }),
        pageUser({ userId: "2", handle: "with space" }),
        pageUser({
          userId: "3",
          handle: "a".repeat(DEFAULT_FOLLOWING_BATCH_LIMITS.maxHandleLength + 1),
        }),
        pageUser({ userId: "4", handle: 7 }),
        pageUser({ userId: "5", handle: "good_one" }),
      ],
      TRUSTED_TIME,
    );

    expect(users.map((user) => user.handle)).toEqual(["good_one"]);
  });

  it("drops entries that are not plain records", () => {
    const users = validateFollowingUsers(
      [null, undefined, "alice", 7, [], new Map(), pageUser()],
      TRUSTED_TIME,
    );

    expect(users.map((user) => user.userId)).toEqual(["1"]);
  });

  it("keeps only an explicit boolean relationship", () => {
    const users = validateFollowingUsers(
      [
        pageUser({ userId: "1", handle: "a", followedBy: true }),
        pageUser({ userId: "2", handle: "b", followedBy: false }),
        pageUser({ userId: "3", handle: "c", followedBy: null }),
        pageUser({ userId: "4", handle: "d", followedBy: undefined }),
        pageUser({ userId: "5", handle: "e", followedBy: "false" }),
        pageUser({ userId: "6", handle: "f", followedBy: 0 }),
      ],
      TRUSTED_TIME,
    );

    expect(users.map((user) => user.followedBy)).toEqual([true, false, null, null, null, null]);
  });

  it("keeps only absolute https avatars", () => {
    const users = validateFollowingUsers(
      [
        pageUser({ userId: "1", handle: "a", avatarUrl: "http://x.com/a.jpg" }),
        pageUser({ userId: "2", handle: "b", avatarUrl: "javascript:alert(1)" }),
        pageUser({ userId: "3", handle: "c", avatarUrl: "data:image/png;base64,AAAA" }),
        pageUser({ userId: "4", handle: "d", avatarUrl: "/relative.jpg" }),
        pageUser({ userId: "5", handle: "e", avatarUrl: 7 }),
        pageUser({
          userId: "6",
          handle: "f",
          avatarUrl: `https://x.com/${"a".repeat(DEFAULT_FOLLOWING_BATCH_LIMITS.maxAvatarUrlLength)}.jpg`,
        }),
        pageUser({ userId: "7", handle: "g", avatarUrl: "https://pbs.x.com/ok.jpg" }),
      ],
      TRUSTED_TIME,
    );

    expect(users.map((user) => user.avatarUrl)).toEqual([
      null,
      null,
      null,
      null,
      null,
      null,
      "https://pbs.x.com/ok.jpg",
    ]);
  });

  it("repairs display names without dropping the record", () => {
    const users = validateFollowingUsers(
      [
        pageUser({ userId: "1", handle: "a", name: "  Spaced  " }),
        pageUser({ userId: "2", handle: "b", name: 7 }),
        pageUser({
          userId: "3",
          handle: "c",
          name: "x".repeat(DEFAULT_FOLLOWING_BATCH_LIMITS.maxNameLength + 50),
        }),
      ],
      TRUSTED_TIME,
    );

    expect(users[0]?.name).toBe("Spaced");
    expect(users[1]?.name).toBe("");
    expect(users[2]?.name).toHaveLength(DEFAULT_FOLLOWING_BATCH_LIMITS.maxNameLength);
  });

  it("dedupes by user id and keeps the first record", () => {
    const users = validateFollowingUsers(
      [
        pageUser({ userId: "1", handle: "first", followedBy: true }),
        pageUser({ userId: "1", handle: "second", followedBy: false }),
      ],
      TRUSTED_TIME,
    );

    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ handle: "first", followedBy: true });
  });

  it("never returns extra properties the page attached", () => {
    const users = validateFollowingUsers([pageUser({ cookie: "auth_token=secret" })], TRUSTED_TIME);

    expect(Object.keys(users[0] ?? {}).sort()).toEqual([
      "avatarUrl",
      "followedBy",
      "handle",
      "name",
      "syncedAt",
      "userId",
    ]);
  });
});
