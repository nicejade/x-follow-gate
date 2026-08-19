/**
 * Contract for the passive MAIN-world observer.
 *
 * The observer must be invisible to the page: it never issues a request, never
 * changes arguments, headers, timing, or the resolution of a call it wraps, and
 * it never forwards anything but normalized accounts.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_OBSERVER_LIMITS,
  installFollowingDataObserver,
  isFollowingTimelineUrl,
  type ObserverScope,
} from "@/content/main-world";

const ORIGIN = "https://x.com";
const FOLLOWING_URL = "https://x.com/i/api/graphql/AbC123dEf/Following?variables=%7B%7D";
const LOCATION = {
  origin: ORIGIN,
  hostname: "x.com",
  href: "https://x.com/alpha_user/following",
};

interface PostedMessage {
  message: unknown;
  targetOrigin: string;
}

/** Minimal `XMLHttpRequest` stand-in: no network, fully synchronous events. */
class FakeXhr {
  public status = 200;
  public responseType = "";
  public responseURL = "";
  public response: unknown = null;
  public openArgs: unknown[] = [];
  public sendArgs: unknown[] = [];
  public textBody = "";
  public responseTextReads = 0;

  private readonly listeners: Array<[string, () => void]> = [];

  public get responseText(): string {
    this.responseTextReads += 1;
    if (this.responseType !== "" && this.responseType !== "text") {
      throw new Error("InvalidStateError: responseText is unavailable");
    }

    return this.textBody;
  }

  public addEventListener(type: string, listener: () => void): void {
    this.listeners.push([type, listener]);
  }

  public open(...args: unknown[]): void {
    this.openArgs = args;
  }

  public send(...args: unknown[]): void {
    this.sendArgs = args;
  }

  public dispatch(type: string): void {
    for (const [listenerType, listener] of this.listeners) {
      if (listenerType === type) {
        listener();
      }
    }
  }
}

function userResult(index: number): unknown {
  return {
    __typename: "User",
    rest_id: `10000000000000000${String(index).padStart(3, "0")}`,
    core: { name: `Synthetic ${index}`, screen_name: `user_${index}` },
    relationship_perspectives: { followed_by: index % 2 === 0 },
  };
}

function followingPayload(count = 1, extra: Record<string, unknown> = {}): unknown {
  return {
    ...extra,
    data: {
      user: {
        result: {
          __typename: "User",
          timeline: {
            timeline: {
              instructions: [
                {
                  type: "TimelineAddEntries",
                  entries: Array.from({ length: count }, (_unused, index) => ({
                    entryId: `user-${index}`,
                    content: {
                      entryType: "TimelineTimelineItem",
                      itemContent: {
                        itemType: "TimelineUser",
                        user_results: { result: userResult(index) },
                      },
                    },
                  })),
                },
              ],
            },
          },
        },
      },
    },
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
    ...init,
  });
}

async function flush(): Promise<void> {
  for (let index = 0; index < 3; index += 1) {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

describe("isFollowingTimelineUrl", () => {
  const base = LOCATION.href;

  it("accepts Following timeline endpoints", () => {
    const accepted = [
      FOLLOWING_URL,
      "https://x.com/i/api/graphql/AbC/Following",
      "https://twitter.com/i/api/graphql/AbC/Following?variables=%7B%7D",
      "https://api.x.com/graphql/AbC/UserFollowingTimeline",
      "/i/api/graphql/AbC/Following?variables=%7B%7D",
      "https://x.com/i/api/1.1/friends/list.json?count=20",
    ];

    for (const url of accepted) {
      expect(isFollowingTimelineUrl(url, base), url).toBe(true);
    }
  });

  it("rejects every other endpoint", () => {
    const rejected = [
      "https://x.com/i/api/graphql/AbC/Followers",
      "https://x.com/i/api/graphql/AbC/BlueVerifiedFollowers",
      "https://x.com/i/api/graphql/AbC/FollowersYouKnow",
      "https://x.com/i/api/graphql/AbC/HomeLatestTimeline",
      "https://x.com/i/api/1.1/jot/client_event.json",
      "https://evil.example.com/i/api/graphql/AbC/Following",
      "https://x.com.evil.example.com/i/api/graphql/AbC/Following",
      "http://x.com/i/api/graphql/AbC/Following",
      "https://x.com/alpha_user/following",
      "not a url at all",
      "",
    ];

    for (const url of rejected) {
      expect(isFollowingTimelineUrl(url, base), url).toBe(false);
    }
  });
});

describe("installFollowingDataObserver · installation", () => {
  it("restores the original fetch and XHR methods on uninstall", () => {
    const originalFetch = vi.fn(async () => jsonResponse({}));
    const originalOpen = FakeXhr.prototype.open;
    const originalSend = FakeXhr.prototype.send;
    const scope: ObserverScope = {
      fetch: originalFetch as unknown as typeof fetch,
      XMLHttpRequest: FakeXhr as unknown as typeof XMLHttpRequest,
      postMessage: vi.fn(),
      location: LOCATION,
    };

    const uninstall = installFollowingDataObserver(scope);

    expect(scope.fetch).not.toBe(originalFetch);
    expect(FakeXhr.prototype.open).not.toBe(originalOpen);
    expect(FakeXhr.prototype.send).not.toBe(originalSend);

    uninstall();

    expect(scope.fetch).toBe(originalFetch);
    expect(FakeXhr.prototype.open).toBe(originalOpen);
    expect(FakeXhr.prototype.send).toBe(originalSend);
  });

  it("does not double-wrap when installed twice", () => {
    const scope: ObserverScope = {
      fetch: vi.fn(async () => jsonResponse({})) as unknown as typeof fetch,
      postMessage: vi.fn(),
      location: LOCATION,
    };

    const uninstall = installFollowingDataObserver(scope);
    const patched = scope.fetch;

    installFollowingDataObserver(scope)();

    expect(scope.fetch).toBe(patched);

    uninstall();
  });

  it("installs nothing when the scope exposes neither fetch nor XHR", () => {
    const scope: ObserverScope = { postMessage: vi.fn(), location: LOCATION };

    expect(() => {
      installFollowingDataObserver(scope)();
    }).not.toThrow();
  });

  it("keeps the identity of the fetch function surface", () => {
    const originalFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({}),
    );
    const scope: ObserverScope = {
      fetch: originalFetch as unknown as typeof fetch,
      postMessage: vi.fn(),
      location: LOCATION,
    };

    const uninstall = installFollowingDataObserver(scope);

    expect(scope.fetch?.name).toBe(originalFetch.name);
    expect(scope.fetch?.length).toBe(originalFetch.length);

    uninstall();
  });
});

describe("installFollowingDataObserver · fetch transparency", () => {
  let posted: PostedMessage[];
  let scope: ObserverScope;
  let originalFetch: ReturnType<typeof vi.fn>;
  let uninstall: () => void;

  beforeEach(() => {
    posted = [];
    originalFetch = vi.fn(() => Promise.resolve(jsonResponse(followingPayload())));
    scope = {
      fetch: originalFetch as unknown as typeof fetch,
      postMessage: (message, targetOrigin) => {
        posted.push({ message, targetOrigin });
      },
      location: LOCATION,
    };
    uninstall = installFollowingDataObserver(scope);

    return () => {
      uninstall();
    };
  });

  it("returns the very promise the original fetch produced", async () => {
    const expected = Promise.resolve(jsonResponse({}));
    originalFetch.mockReturnValue(expected);

    const actual = scope.fetch?.(FOLLOWING_URL);

    expect(actual).toBe(expected);
    await expected;
  });

  it("forwards arguments by identity and preserves arity", async () => {
    const request = new Request(FOLLOWING_URL, { headers: { "x-client": "page" } });
    const init: RequestInit = { method: "GET", headers: { "x-csrf-token": "ct0-secret" } };

    await scope.fetch?.(request, init);
    await scope.fetch?.(FOLLOWING_URL);

    expect(originalFetch.mock.calls[0]).toHaveLength(2);
    expect(originalFetch.mock.calls[0]?.[0]).toBe(request);
    expect(originalFetch.mock.calls[0]?.[1]).toBe(init);
    expect(originalFetch.mock.calls[1]).toHaveLength(1);
  });

  it("calls the original with the scope as receiver for a bare invocation", async () => {
    const bareFetch = scope.fetch;

    await bareFetch?.(FOLLOWING_URL);

    expect(originalFetch.mock.contexts[0]).toBe(scope);
  });

  it("propagates a rejection unchanged", async () => {
    const failure = new TypeError("network down");
    originalFetch.mockReturnValue(Promise.reject(failure));

    await expect(scope.fetch?.(FOLLOWING_URL)).rejects.toBe(failure);
    await flush();

    expect(posted).toEqual([]);
  });

  it("leaves the response body available to the caller", async () => {
    const response = await (scope.fetch?.(FOLLOWING_URL) as Promise<Response>);

    expect(response.bodyUsed).toBe(false);

    const body = await response.json();

    await flush();

    expect(body).toEqual(followingPayload());
    expect(posted).toHaveLength(1);
  });

  it("survives a body that cannot be parsed without disturbing the caller", async () => {
    originalFetch.mockReturnValue(Promise.resolve(jsonResponse("{not json")));

    const response = await (scope.fetch?.(FOLLOWING_URL) as Promise<Response>);

    await flush();

    expect(await response.text()).toBe("{not json");
    expect(posted).toEqual([]);
  });
});

describe("installFollowingDataObserver · what reaches the page bridge", () => {
  let posted: PostedMessage[];
  let scope: ObserverScope;
  let originalFetch: ReturnType<typeof vi.fn>;
  let uninstall: () => void;

  beforeEach(() => {
    posted = [];
    originalFetch = vi.fn(async () => jsonResponse(followingPayload()));
    scope = {
      fetch: originalFetch as unknown as typeof fetch,
      postMessage: (message, targetOrigin) => {
        posted.push({ message, targetOrigin });
      },
      location: LOCATION,
    };
    uninstall = installFollowingDataObserver(scope);

    return () => {
      uninstall();
    };
  });

  it("posts only the normalized users, tagged and origin-targeted", async () => {
    await scope.fetch?.(FOLLOWING_URL);
    await flush();

    expect(posted).toHaveLength(1);
    expect(posted[0]?.targetOrigin).toBe(ORIGIN);
    expect(posted[0]?.message).toEqual({
      source: "follow-gate",
      type: "FOLLOWING_PAGE_DATA",
      users: [
        {
          userId: "10000000000000000000",
          handle: "user_0",
          name: "Synthetic 0",
          avatarUrl: null,
          followedBy: true,
          isBlueVerified: null,
          protected: null,
          statusesCount: null,
          friendsCount: null,
          followersCount: null,
          syncedAt: expect.any(Number),
        },
      ],
    });
    expect(Object.keys(posted[0]?.message as object)).toEqual(["source", "type", "users"]);
  });

  it("never forwards raw payload, cursors, tokens, cookies, or headers", async () => {
    const secrets = ["Bearer SECRET_TOKEN", "ct0-secret", "auth_token=SECRET", "CURSOR_SECRET"];
    originalFetch.mockResolvedValue(
      jsonResponse(
        followingPayload(1, {
          cursor: "CURSOR_SECRET",
          headers: { authorization: "Bearer SECRET_TOKEN", "x-csrf-token": "ct0-secret" },
          cookie: "auth_token=SECRET",
        }),
      ),
    );

    await scope.fetch?.(FOLLOWING_URL);
    await flush();

    const serialized = JSON.stringify(posted);

    for (const secret of secrets) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("stays silent for responses that are not a Following timeline", async () => {
    const ignored = [
      "https://x.com/i/api/graphql/AbC/Followers",
      "https://x.com/i/api/1.1/jot/client_event.json",
      "https://cdn.example.com/i/api/graphql/AbC/Following",
    ];

    for (const url of ignored) {
      await scope.fetch?.(url);
    }
    await flush();

    expect(posted).toEqual([]);
  });

  it("stays silent for failed, non-JSON, or user-free responses", async () => {
    originalFetch.mockResolvedValueOnce(
      jsonResponse(followingPayload(), { status: 429, statusText: "Too Many Requests" }),
    );
    await scope.fetch?.(FOLLOWING_URL);

    originalFetch.mockResolvedValueOnce(
      new Response("<html></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );
    await scope.fetch?.(FOLLOWING_URL);

    originalFetch.mockResolvedValueOnce(jsonResponse({ data: { user: { result: {} } } }));
    await scope.fetch?.(FOLLOWING_URL);

    await flush();

    expect(posted).toEqual([]);
  });

  it("stays silent when the response is larger than the parse budget", async () => {
    originalFetch.mockResolvedValue(
      jsonResponse(followingPayload(), {
        headers: {
          "content-type": "application/json",
          "content-length": String(DEFAULT_OBSERVER_LIMITS.maxResponseChars + 1),
        },
      }),
    );

    await scope.fetch?.(FOLLOWING_URL);
    await flush();

    expect(posted).toEqual([]);
  });

  it("resolves a relative request URL against the page location", async () => {
    await scope.fetch?.("/i/api/graphql/AbC/Following?variables=%7B%7D");
    await flush();

    expect(posted).toHaveLength(1);
  });

  it("splits a large batch into bounded messages without losing or repeating users", async () => {
    const count = DEFAULT_OBSERVER_LIMITS.maxUsersPerMessage + 25;
    originalFetch.mockResolvedValue(jsonResponse(followingPayload(count)));

    await scope.fetch?.(FOLLOWING_URL);
    await flush();

    expect(posted).toHaveLength(2);

    const handles = posted.flatMap((entry) => {
      const message = entry.message as { users: Array<{ handle: string }> };

      expect(message.users.length).toBeLessThanOrEqual(DEFAULT_OBSERVER_LIMITS.maxUsersPerMessage);

      return message.users.map((user) => user.handle);
    });

    expect(new Set(handles).size).toBe(count);
  });
});

describe("installFollowingDataObserver · XHR transparency", () => {
  let posted: PostedMessage[];
  let scope: ObserverScope;
  let uninstall: () => void;

  beforeEach(() => {
    posted = [];
    scope = {
      XMLHttpRequest: FakeXhr as unknown as typeof XMLHttpRequest,
      postMessage: (message, targetOrigin) => {
        posted.push({ message, targetOrigin });
      },
      location: LOCATION,
    };
    uninstall = installFollowingDataObserver(scope);

    return () => {
      uninstall();
    };
  });

  it("forwards open and send arguments untouched", () => {
    const xhr = new FakeXhr();
    const body = new URLSearchParams({ variables: "{}" });

    xhr.open("POST", FOLLOWING_URL, true, "user", "password");
    xhr.send(body);

    expect(xhr.openArgs).toEqual(["POST", FOLLOWING_URL, true, "user", "password"]);
    expect(xhr.sendArgs).toHaveLength(1);
    expect(xhr.sendArgs[0]).toBe(body);
  });

  it("parses a text response after load", () => {
    const xhr = new FakeXhr();

    xhr.open("GET", FOLLOWING_URL);
    xhr.send();
    xhr.textBody = JSON.stringify(followingPayload());
    xhr.dispatch("load");

    expect(posted).toHaveLength(1);
    expect(xhr.textBody).toBe(JSON.stringify(followingPayload()));
  });

  it("posts once per completed request when an XHR instance is reused", () => {
    const xhr = new FakeXhr();
    xhr.textBody = JSON.stringify(followingPayload());

    xhr.open("GET", FOLLOWING_URL);
    xhr.send();
    xhr.dispatch("load");

    xhr.open("GET", FOLLOWING_URL);
    xhr.send();
    xhr.dispatch("load");

    expect(posted).toHaveLength(2);
  });

  it("uses the parsed response when responseType is json", () => {
    const xhr = new FakeXhr();

    xhr.open("GET", FOLLOWING_URL);
    xhr.send();
    xhr.responseType = "json";
    xhr.response = followingPayload();
    xhr.dispatch("load");

    expect(posted).toHaveLength(1);
    expect(xhr.responseTextReads).toBe(0);
  });

  it("prefers the final response URL over the requested one", () => {
    const xhr = new FakeXhr();

    xhr.open("GET", "https://x.com/i/api/graphql/AbC/Followers");
    xhr.send();
    xhr.responseURL = FOLLOWING_URL;
    xhr.textBody = JSON.stringify(followingPayload());
    xhr.dispatch("load");

    expect(posted).toHaveLength(1);
  });

  it("never touches responseText for binary response types", () => {
    const xhr = new FakeXhr();

    xhr.open("GET", FOLLOWING_URL);
    xhr.send();
    xhr.responseType = "blob";

    expect(() => {
      xhr.dispatch("load");
    }).not.toThrow();

    expect(xhr.responseTextReads).toBe(0);
    expect(posted).toEqual([]);
  });

  it("ignores unrelated URLs and failed requests", () => {
    const unrelated = new FakeXhr();
    unrelated.open("GET", "https://x.com/i/api/graphql/AbC/Followers");
    unrelated.send();
    unrelated.textBody = JSON.stringify(followingPayload());
    unrelated.dispatch("load");

    const failed = new FakeXhr();
    failed.open("GET", FOLLOWING_URL);
    failed.send();
    failed.status = 403;
    failed.textBody = JSON.stringify(followingPayload());
    failed.dispatch("load");

    expect(posted).toEqual([]);
  });
});

describe("main-world bundle constraints", () => {
  const sources = ["main-world.ts", "x-data-adapter.ts", "../shared/rules.ts"];

  function readSource(file: string): string {
    return readFileSync(resolve(process.cwd(), "src/content", file), "utf8");
  }

  it("uses no Chrome extension API in the MAIN-world sources", () => {
    for (const file of sources) {
      const source = readSource(file);

      expect(source, file).not.toMatch(/\bchrome\s*\./);
      expect(source, file).not.toMatch(/\bbrowser\s*\.\s*runtime\b/);
    }
  });

  it("never constructs a request in the MAIN-world sources", () => {
    for (const file of sources) {
      const source = readSource(file);

      expect(source, file).not.toMatch(/new\s+Request\b/);
      expect(source, file).not.toMatch(/new\s+XMLHttpRequest\b/);
      expect(source, file).not.toMatch(/\bnavigator\s*\.\s*sendBeacon\b/);
    }
  });
});
