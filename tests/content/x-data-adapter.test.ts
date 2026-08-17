/**
 * Parser contract for page-loaded Following data.
 *
 * The fixture used here is synthetic and de-identified (see its `__provenance`
 * field): no signed-in X session was available while authoring these tests, so
 * the nesting is reconstructed by hand and must be re-verified against a real,
 * redacted capture before release.
 */

import { describe, expect, it, vi } from "vitest";

import { DEFAULT_TRAVERSAL_LIMITS, extractFollowingUsers } from "@/content/x-data-adapter";

import fixture from "../fixtures/following-response.json";

const NOW = 1_700_000_000_000;

/** Wraps a `user_results.result` payload in a timeline item entry. */
function userEntry(result: unknown, entryId = "user-entry"): unknown {
  return {
    entryId,
    sortIndex: "1900000000000000000",
    content: {
      entryType: "TimelineTimelineItem",
      __typename: "TimelineTimelineItem",
      itemContent: {
        itemType: "TimelineUser",
        __typename: "TimelineUser",
        user_results: { result },
      },
    },
  };
}

/** Wraps timeline entries in the realistic `data.user.result.timeline` nesting. */
function timelinePayload(entries: unknown[]): unknown {
  return {
    data: {
      user: {
        result: {
          __typename: "User",
          timeline: {
            timeline: {
              instructions: [{ type: "TimelineAddEntries", entries }],
            },
          },
        },
      },
    },
  };
}

/** Minimal well-formed user result in the current (`core` / `avatar`) shape. */
function modernUser(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    __typename: "User",
    rest_id: "1000000000000000001",
    core: { name: "Synthetic Alpha", screen_name: "alpha_user" },
    avatar: { image_url: "https://pbs.twimg.com/profile_images/1/synthetic_normal.jpg" },
    ...overrides,
  };
}

function extractFrom(result: unknown): ReturnType<typeof extractFollowingUsers> {
  return extractFollowingUsers(timelinePayload([userEntry(result)]), NOW);
}

describe("extractFollowingUsers · sanitized fixture", () => {
  it("extracts exactly the well-formed users, in document order", () => {
    expect(extractFollowingUsers(fixture, NOW)).toEqual([
      {
        userId: "1000000000000000001",
        handle: "alpha_user",
        name: "Synthetic Alpha",
        avatarUrl: "https://pbs.twimg.com/profile_images/1000000000000000001/synthetic_normal.jpg",
        followedBy: true,
        syncedAt: NOW,
      },
      {
        userId: "1000000000000000002",
        handle: "beta_user",
        name: "Synthetic Beta",
        avatarUrl: "https://pbs.twimg.com/profile_images/1000000000000000002/synthetic_normal.jpg",
        followedBy: false,
        syncedAt: NOW,
      },
      {
        userId: "1000000000000000003",
        handle: "gamma_user",
        name: "Synthetic Gamma",
        avatarUrl: null,
        followedBy: null,
        syncedAt: NOW,
      },
    ]);
  });

  it("never yields tombstoned, unavailable, or promoted accounts", () => {
    const handles = extractFollowingUsers(fixture, NOW).map((user) => user.handle);

    expect(handles).not.toContain("tombstoned_user");
    expect(handles).not.toContain("unavailable_user");
    expect(handles).not.toContain("promoted_user");
  });
});

describe("extractFollowingUsers · relationship state", () => {
  it("reads `relationship_perspectives.followed_by`", () => {
    expect(
      extractFrom(modernUser({ relationship_perspectives: { followed_by: true } }))[0]?.followedBy,
    ).toBe(true);

    expect(
      extractFrom(modernUser({ relationship_perspectives: { followed_by: false } }))[0]?.followedBy,
    ).toBe(false);
  });

  it("falls back to the legacy `legacy.followed_by` field", () => {
    const users = extractFrom(modernUser({ legacy: { followed_by: false, followers_count: 3 } }));

    expect(users[0]?.followedBy).toBe(false);
  });

  it("prefers the perspectives field when both shapes are present", () => {
    const users = extractFrom(
      modernUser({
        relationship_perspectives: { followed_by: true },
        legacy: { followed_by: false },
      }),
    );

    expect(users[0]?.followedBy).toBe(true);
  });

  it("represents a missing relationship as null and never as false", () => {
    const users = extractFrom(modernUser());

    expect(users[0]?.followedBy).toBeNull();
    expect(users[0]?.followedBy).not.toBe(false);
  });

  it("treats a non-boolean relationship value as unknown", () => {
    const values: unknown[] = ["false", "true", 0, 1, null, {}, [], "0"];

    for (const followed_by of values) {
      const users = extractFrom(modernUser({ relationship_perspectives: { followed_by } }));

      expect(users[0]?.followedBy, `followed_by: ${JSON.stringify(followed_by)}`).toBeNull();
    }
  });

  it("ignores a non-boolean perspectives value but still uses the legacy fallback", () => {
    const users = extractFrom(
      modernUser({
        relationship_perspectives: { followed_by: "false" },
        legacy: { followed_by: true },
      }),
    );

    expect(users[0]?.followedBy).toBe(true);
  });
});

describe("extractFollowingUsers · ignored timeline content", () => {
  it("skips a tombstone subtree even when it embeds a user result", () => {
    const payload = timelinePayload([
      {
        entryId: "tombstone-1",
        content: {
          entryType: "TimelineTimelineItem",
          itemContent: {
            itemType: "TimelineTombstone",
            user_results: {
              result: modernUser({ relationship_perspectives: { followed_by: false } }),
            },
          },
        },
      },
    ]);

    expect(extractFollowingUsers(payload, NOW)).toEqual([]);
  });

  it("skips an unavailable user result", () => {
    expect(
      extractFrom({
        __typename: "UserUnavailable",
        rest_id: "1000000000000000009",
        reason: "Suspended",
        core: { name: "Gone", screen_name: "gone_user" },
      }),
    ).toEqual([]);
  });

  it("skips a promoted entry identified by `promotedMetadata`", () => {
    const payload = timelinePayload([
      {
        entryId: "promoted-user-1",
        content: {
          entryType: "TimelineTimelineItem",
          itemContent: {
            itemType: "TimelineUser",
            promotedMetadata: { disclosureType: "NoDisclosure" },
            user_results: { result: modernUser() },
          },
        },
      },
    ]);

    expect(extractFollowingUsers(payload, NOW)).toEqual([]);
  });

  it("skips a promoted entry identified by its entry id", () => {
    const payload = timelinePayload([userEntry(modernUser(), "promoted-tweet-1")]);

    expect(extractFollowingUsers(payload, NOW)).toEqual([]);
  });

  it("yields nothing for cursor-only instructions", () => {
    const payload = timelinePayload([
      {
        entryId: "cursor-top-1",
        content: {
          entryType: "TimelineTimelineCursor",
          value: "REDACTED",
          cursorType: "Top",
        },
      },
      {
        entryId: "cursor-bottom-1",
        content: {
          entryType: "TimelineTimelineCursor",
          value: "REDACTED",
          cursorType: "Bottom",
        },
      },
    ]);

    expect(extractFollowingUsers(payload, NOW)).toEqual([]);
  });

  it("does not harvest users nested inside an already recognized user", () => {
    const users = extractFrom(
      modernUser({
        legacy: {
          affiliates_highlighted_label: {
            label: {
              userResults: {
                result: {
                  __typename: "User",
                  rest_id: "9000000000000000009",
                  core: { name: "Affiliate", screen_name: "affiliate_org" },
                  relationship_perspectives: { followed_by: false },
                },
              },
            },
          },
        },
      }),
    );

    expect(users.map((user) => user.handle)).toEqual(["alpha_user"]);
  });

  it("keeps traversing past a recognized user wrapper that carries no identity", () => {
    // `data.user.result` of the real Following query is `__typename: "User"`
    // without `rest_id`; the timeline lives inside it.
    const users = extractFollowingUsers(fixture, NOW);

    expect(users.length).toBeGreaterThan(0);
  });

  it("descends into a complete profile owner's timeline without collecting the owner", () => {
    const payload = {
      data: {
        user: {
          result: {
            ...modernUser({ relationship_perspectives: { followed_by: true } }),
            timeline: {
              timeline: {
                instructions: [
                  {
                    type: "TimelineAddEntries",
                    entries: [
                      userEntry(
                        modernUser({
                          rest_id: "1000000000000000002",
                          core: { name: "Nested", screen_name: "nested_user" },
                          relationship_perspectives: { followed_by: false },
                        }),
                      ),
                    ],
                  },
                ],
              },
            },
          },
        },
      },
    };

    expect(extractFollowingUsers(payload, NOW).map((user) => user.handle)).toEqual(["nested_user"]);
  });

  it("descends into timeline_v2 without collecting its complete profile owner", () => {
    const payload = {
      data: {
        user: {
          result: {
            ...modernUser({ relationship_perspectives: { followed_by: false } }),
            timeline_v2: {
              timeline: {
                instructions: [
                  {
                    type: "TimelineAddEntries",
                    entries: [
                      userEntry(
                        modernUser({
                          rest_id: "1000000000000000002",
                          core: { name: "Nested V2", screen_name: "nested_v2_user" },
                          relationship_perspectives: { followed_by: true },
                        }),
                      ),
                    ],
                  },
                ],
              },
            },
          },
        },
      },
    };

    expect(extractFollowingUsers(payload, NOW).map((user) => user.handle)).toEqual([
      "nested_v2_user",
    ]);
  });
});

describe("extractFollowingUsers · malformed users", () => {
  it("ignores a user without a usable id", () => {
    expect(extractFrom(modernUser({ rest_id: undefined }))).toEqual([]);
    expect(extractFrom(modernUser({ rest_id: "" }))).toEqual([]);
    expect(extractFrom(modernUser({ rest_id: "   " }))).toEqual([]);
    expect(extractFrom(modernUser({ rest_id: 1_000_000_000 }))).toEqual([]);
    expect(extractFrom(modernUser({ rest_id: "a".repeat(64) }))).toEqual([]);
    expect(extractFrom(modernUser({ rest_id: "10 00" }))).toEqual([]);
  });

  it("ignores a user without a usable handle", () => {
    expect(extractFrom(modernUser({ core: { name: "No Handle" } }))).toEqual([]);
    expect(extractFrom(modernUser({ core: { screen_name: "" } }))).toEqual([]);
    expect(extractFrom(modernUser({ core: { screen_name: "@" } }))).toEqual([]);
    expect(extractFrom(modernUser({ core: { screen_name: "bad handle" } }))).toEqual([]);
    expect(extractFrom(modernUser({ core: { screen_name: "bad/handle" } }))).toEqual([]);
    expect(extractFrom(modernUser({ core: { screen_name: "a".repeat(40) } }))).toEqual([]);
    expect(extractFrom(modernUser({ core: { screen_name: 12345 } }))).toEqual([]);
  });

  it("ignores non-object user results", () => {
    for (const result of ["a string", 42, null, true, ["array"]]) {
      expect(extractFrom(result), JSON.stringify(result)).toEqual([]);
    }
  });

  it("keeps the well-formed users of a batch that also contains malformed ones", () => {
    const payload = timelinePayload([
      userEntry(modernUser({ rest_id: "" }), "user-broken-1"),
      userEntry(
        modernUser({
          rest_id: "1000000000000000002",
          core: { name: "Good", screen_name: "good_user" },
        }),
        "user-good",
      ),
      userEntry("not-an-object", "user-broken-2"),
    ]);

    expect(extractFollowingUsers(payload, NOW).map((user) => user.handle)).toEqual(["good_user"]);
  });
});

describe("extractFollowingUsers · field normalization", () => {
  it("normalizes the handle to lowercase without a leading @", () => {
    const users = extractFrom(
      modernUser({ core: { name: "Mixed", screen_name: "  @Alpha_USER " } }),
    );

    expect(users[0]?.handle).toBe("alpha_user");
  });

  it("trims the display name and caps its length", () => {
    const users = extractFrom(
      modernUser({ core: { name: `  ${"n".repeat(400)}  `, screen_name: "alpha_user" } }),
    );

    expect(users[0]?.name).toHaveLength(DEFAULT_TRAVERSAL_LIMITS.maxNameLength);
  });

  it("falls back to an empty name instead of dropping the user", () => {
    const users = extractFrom(modernUser({ core: { screen_name: "alpha_user" } }));

    expect(users[0]?.name).toBe("");
  });

  it("reads the legacy avatar field", () => {
    const users = extractFrom({
      __typename: "User",
      rest_id: "1000000000000000002",
      legacy: {
        name: "Legacy",
        screen_name: "legacy_user",
        profile_image_url_https: "https://pbs.twimg.com/profile_images/2/legacy_normal.jpg",
      },
    });

    expect(users[0]?.avatarUrl).toBe("https://pbs.twimg.com/profile_images/2/legacy_normal.jpg");
  });

  it("rejects an avatar URL that is not https", () => {
    const rejected = [
      "javascript:alert(1)",
      "data:image/png;base64,AAAA",
      "http://pbs.twimg.com/profile_images/2/normal.jpg",
      "//pbs.twimg.com/profile_images/2/normal.jpg",
      `https://pbs.twimg.com/${"a".repeat(4096)}.jpg`,
      42,
      {},
    ];

    for (const image_url of rejected) {
      const users = extractFrom(modernUser({ avatar: { image_url } }));

      expect(users[0]?.avatarUrl, JSON.stringify(image_url)).toBeNull();
    }
  });
});

describe("extractFollowingUsers · deduplication", () => {
  it("deduplicates repeated user ids and fills gaps from later occurrences", () => {
    const payload = timelinePayload([
      userEntry(
        {
          __typename: "User",
          rest_id: "1000000000000000001",
          core: { screen_name: "alpha_user" },
        },
        "user-first",
      ),
      userEntry(
        modernUser({
          core: { name: "Synthetic Alpha", screen_name: "alpha_user" },
          relationship_perspectives: { followed_by: true },
        }),
        "user-repeat",
      ),
    ]);

    expect(extractFollowingUsers(payload, NOW)).toEqual([
      {
        userId: "1000000000000000001",
        handle: "alpha_user",
        name: "Synthetic Alpha",
        avatarUrl: "https://pbs.twimg.com/profile_images/1/synthetic_normal.jpg",
        followedBy: true,
        syncedAt: NOW,
      },
    ]);
  });

  it("never lets a later duplicate overwrite a known relationship", () => {
    const payload = timelinePayload([
      userEntry(modernUser({ relationship_perspectives: { followed_by: true } }), "user-first"),
      userEntry(modernUser({ relationship_perspectives: { followed_by: false } }), "user-repeat"),
    ]);

    expect(extractFollowingUsers(payload, NOW)[0]?.followedBy).toBe(true);
  });
});

describe("extractFollowingUsers · purity and clock", () => {
  it("does not mutate the payload", () => {
    const payload = timelinePayload([userEntry(modernUser())]);
    const snapshot = structuredClone(payload);

    extractFollowingUsers(payload, NOW);

    expect(payload).toEqual(snapshot);
  });

  it("stamps `syncedAt` from the current clock by default", () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);

    const users = extractFollowingUsers(timelinePayload([userEntry(modernUser())]));

    expect(users[0]?.syncedAt).toBe(NOW);
  });
});

describe("extractFollowingUsers · runtime guards", () => {
  it("returns an empty list for payloads that are not objects", () => {
    for (const payload of [null, undefined, "", "{}", 0, 42, true, Symbol("x")]) {
      expect(extractFollowingUsers(payload, NOW), String(payload)).toEqual([]);
    }
  });

  it("terminates on a cyclic payload", () => {
    const cyclic: Record<string, unknown> = {
      instructions: [{ entries: [userEntry(modernUser())] }],
    };
    cyclic.self = cyclic;
    cyclic.nested = { parent: cyclic };

    expect(extractFollowingUsers(cyclic, NOW).map((user) => user.handle)).toEqual(["alpha_user"]);
  });

  it("stops descending past the depth limit", () => {
    let deep: unknown = userEntry(modernUser());
    for (let i = 0; i < 200; i += 1) {
      deep = { nested: deep };
    }

    expect(extractFollowingUsers(deep, NOW)).toEqual([]);
    expect(extractFollowingUsers(deep, NOW, { maxDepth: 1_000 })).toHaveLength(1);
  });

  it("stops visiting nodes past the node limit", () => {
    const payload = timelinePayload([
      userEntry(modernUser({ rest_id: "1000000000000000001" }), "user-1"),
      userEntry(
        modernUser({
          rest_id: "1000000000000000002",
          core: { name: "Second", screen_name: "second_user" },
        }),
        "user-2",
      ),
    ]);

    expect(extractFollowingUsers(payload, NOW, { maxNodes: 12 }).length).toBeLessThan(2);
    expect(extractFollowingUsers(payload, NOW)).toHaveLength(2);
  });

  it("stops collecting past the user limit", () => {
    const entries = Array.from({ length: 5 }, (_unused, index) =>
      userEntry(
        modernUser({
          rest_id: `100000000000000000${index}`,
          core: { name: `User ${index}`, screen_name: `user_${index}` },
        }),
        `user-${index}`,
      ),
    );

    expect(extractFollowingUsers(timelinePayload(entries), NOW, { maxUsers: 2 })).toHaveLength(2);
  });

  it("ignores over-long arrays instead of walking them", () => {
    const entries = Array.from({ length: 10 }, (_unused, index) =>
      userEntry(
        modernUser({
          rest_id: `100000000000000000${index}`,
          core: { name: `User ${index}`, screen_name: `user_${index}` },
        }),
        `user-${index}`,
      ),
    );

    expect(extractFollowingUsers(timelinePayload(entries), NOW, { maxArrayLength: 5 })).toEqual([]);
  });

  it("does not pollute Object.prototype from a hostile payload", () => {
    const payload = JSON.parse(
      '{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}',
    );

    extractFollowingUsers(payload, NOW);

    expect(Object.prototype).not.toHaveProperty("polluted");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("ignores exotic host objects while traversing", () => {
    const payload = {
      when: new Date(NOW),
      map: new Map([["user", modernUser()]]),
      set: new Set([modernUser()]),
      fn: () => modernUser(),
      entries: [userEntry(modernUser())],
    };

    expect(extractFollowingUsers(payload, NOW).map((user) => user.handle)).toEqual(["alpha_user"]);
  });
});
