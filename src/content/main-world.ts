/**
 * MAIN-world passive observer.
 *
 * This script runs in the page's own JavaScript world, where X's `fetch` and
 * `XMLHttpRequest` live. It exists for one reason: to read Following data that
 * the page requested for itself while the user scrolls. It must therefore obey
 * three rules without exception.
 *
 * 1. It never initiates a request. There is no request construction, no retry,
 *    no prefetch, and no pagination anywhere in this file.
 * 2. It is transparent to the page. The wrappers forward arguments untouched,
 *    return the original promise instance, never mutate headers, never consume a
 *    body (only a clone), and never alter timing or error behaviour.
 * 3. It leaks nothing. Only normalized `FollowingUser` records leave this world,
 *    posted same-origin to the ISOLATED world. Raw payloads, cursors, cookies,
 *    CSRF tokens, and authorization headers never cross the boundary.
 *
 * No Chrome extension API is reachable from the MAIN world, so this file must
 * not reference one.
 */

import type { FollowingUser } from "@/shared/types";

import { FOLLOWING_PAGE_DATA, MESSAGE_SOURCE } from "./bridge-protocol";
import type { FollowingPageDataMessage } from "./bridge-protocol";
import { extractFollowingUsers } from "./x-data-adapter";

export { FOLLOWING_PAGE_DATA, MESSAGE_SOURCE };
export type { FollowingPageDataMessage };

/** Bounds for untrusted page responses. */
export interface ObserverLimits {
  /** Responses larger than this are not parsed. */
  maxResponseChars: number;
  /** Accounts per posted message, so one huge batch cannot block the page. */
  maxUsersPerMessage: number;
}

export const DEFAULT_OBSERVER_LIMITS: Readonly<ObserverLimits> = Object.freeze({
  maxResponseChars: 8_000_000,
  maxUsersPerMessage: 500,
});

/**
 * The subset of `window` the observer touches. Declaring it explicitly keeps the
 * observer testable and makes the (small) surface auditable.
 */
export interface ObserverScope {
  fetch?: typeof fetch;
  XMLHttpRequest?: typeof XMLHttpRequest;
  postMessage(message: unknown, targetOrigin: string): void;
  location: Pick<Location, "origin" | "hostname" | "href">;
}

/** The instance members the observer reads from an `XMLHttpRequest`. */
interface XhrObservable {
  readonly status: number;
  readonly responseType: string;
  readonly response: unknown;
  readonly responseText: string;
  readonly responseURL: string;
  addEventListener(type: string, listener: () => void): void;
}

/**
 * Loosened view of `XMLHttpRequest.prototype`. The real declaration is
 * overloaded, which makes a forwarding wrapper unassignable; the wrapper still
 * passes every argument through verbatim.
 */
interface XhrPrototype {
  open: (this: XhrObservable, method: string, url: string | URL, ...rest: unknown[]) => void;
  send: (this: XhrObservable, body?: unknown) => void;
}

const X_HOSTS = ["x.com", "twitter.com"] as const;
/** `/graphql/{queryId}/{OperationName}` — the operation name is the last segment. */
const GRAPHQL_OPERATION_PATH = /\/graphql\/[^/]+\/([A-Za-z0-9_]+)$/;
const FRIENDS_LIST_PATH = /\/1\.1\/friends\/list\.json$/;

/** Tracks wrapped functions so a second installation cannot stack wrappers. */
const wrapped = new WeakSet<object>();

function isXHost(hostname: string): boolean {
  return X_HOSTS.some((host) => hostname === host || hostname.endsWith(`.${host}`));
}

/**
 * Whether a URL is a Following timeline endpoint. Everything else — including
 * the Followers timelines and home timelines — is out of scope and never read.
 */
export function isFollowingTimelineUrl(rawUrl: string, base: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl, base);
  } catch {
    return false;
  }

  if (url.protocol !== "https:" || !isXHost(url.hostname)) {
    return false;
  }

  if (FRIENDS_LIST_PATH.test(url.pathname)) {
    return true;
  }

  const operation = GRAPHQL_OPERATION_PATH.exec(url.pathname)?.[1];

  return operation !== undefined && /following/i.test(operation);
}

/** Reads the URL of a `fetch` input without constructing a `Request`. */
function readRequestUrl(input: unknown): string | null {
  if (typeof input === "string") {
    return input;
  }

  if (input instanceof URL) {
    return input.href;
  }

  if (typeof input === "object" && input !== null && "url" in input) {
    const { url } = input as { url: unknown };

    return typeof url === "string" ? url : null;
  }

  return null;
}

/**
 * Installs the passive observers and returns a function that restores the page's
 * originals. Installing twice is a no-op.
 */
export function installFollowingDataObserver(
  scope: ObserverScope,
  limits: Partial<ObserverLimits> = {},
): () => void {
  const budget: ObserverLimits = { ...DEFAULT_OBSERVER_LIMITS, ...limits };
  const restorers: Array<() => void> = [];

  const publish = (payload: unknown): void => {
    let users: FollowingUser[];
    try {
      users = extractFollowingUsers(payload);
    } catch {
      return;
    }

    for (let index = 0; index < users.length; index += budget.maxUsersPerMessage) {
      const message: FollowingPageDataMessage = {
        source: MESSAGE_SOURCE,
        type: FOLLOWING_PAGE_DATA,
        users: users.slice(index, index + budget.maxUsersPerMessage),
      };

      try {
        // Same-origin target only: never `"*"`.
        scope.postMessage(message, scope.location.origin);
      } catch {
        return;
      }
    }
  };

  const publishText = (text: string): void => {
    if (typeof text !== "string" || text.length === 0 || text.length > budget.maxResponseChars) {
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      return;
    }

    publish(payload);
  };

  const restoreFetch = wrapFetch(scope, budget, publishText);
  if (restoreFetch !== null) {
    restorers.push(restoreFetch);
  }

  const restoreXhr = wrapXhr(scope, publish, publishText);
  if (restoreXhr !== null) {
    restorers.push(restoreXhr);
  }

  return () => {
    for (const restore of restorers.splice(0)) {
      restore();
    }
  };
}

function wrapFetch(
  scope: ObserverScope,
  budget: ObserverLimits,
  publishText: (text: string) => void,
): (() => void) | null {
  const original = scope.fetch;
  if (typeof original !== "function" || wrapped.has(original)) {
    return null;
  }

  const patched = function (this: unknown, ...args: Parameters<typeof fetch>): Promise<Response> {
    // A bare `fetch(...)` call from strict-mode page code has no receiver;
    // browsers reject a detached invocation, so the scope is restored.
    const promise = original.apply(this === undefined ? scope : this, args);

    // Observation runs on a derived promise. The caller receives the original
    // one, so its resolution, rejection, and timing are untouched.
    void promise
      .then(
        (response) => {
          observeResponse(scope, budget, publishText, args[0], response);
        },
        () => {
          // The caller owns this rejection; the observer must stay silent.
        },
      )
      .catch(() => {
        // Never surface an observer fault as an unhandled rejection.
      });

    return promise;
  };

  // Page code may feature-detect on these; keep the surface indistinguishable.
  Object.defineProperty(patched, "name", { value: original.name, configurable: true });
  Object.defineProperty(patched, "length", { value: original.length, configurable: true });

  wrapped.add(patched);
  scope.fetch = patched;

  return () => {
    if (scope.fetch === patched) {
      scope.fetch = original;
    }
  };
}

/** Reads a successful Following response through a clone, never the body itself. */
function observeResponse(
  scope: ObserverScope,
  budget: ObserverLimits,
  publishText: (text: string) => void,
  input: unknown,
  response: Response,
): void {
  try {
    if (!response.ok || response.bodyUsed) {
      return;
    }

    const url = response.url !== "" ? response.url : readRequestUrl(input);
    if (url === null || !isFollowingTimelineUrl(url, scope.location.href)) {
      return;
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("json")) {
      return;
    }

    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > budget.maxResponseChars) {
      return;
    }

    // Cloning leaves the page's own body untouched and unread.
    const clone = response.clone();
    void clone.text().then(publishText).catch(noop);
  } catch {
    // Observation is best-effort and must never affect the page.
  }
}

function wrapXhr(
  scope: ObserverScope,
  publish: (payload: unknown) => void,
  publishText: (text: string) => void,
): (() => void) | null {
  const constructor = scope.XMLHttpRequest;
  if (typeof constructor !== "function") {
    return null;
  }

  const prototype = constructor.prototype as unknown as XhrPrototype;
  const originalOpen = prototype.open;
  const originalSend = prototype.send;
  if (
    typeof originalOpen !== "function" ||
    typeof originalSend !== "function" ||
    wrapped.has(originalOpen) ||
    wrapped.has(originalSend)
  ) {
    return null;
  }

  const requestUrls = new WeakMap<object, string>();
  const listening = new WeakSet<object>();

  const observe = (xhr: XhrObservable): void => {
    try {
      if (xhr.status < 200 || xhr.status >= 300) {
        return;
      }

      const url = xhr.responseURL !== "" ? xhr.responseURL : requestUrls.get(xhr);
      if (url === undefined || !isFollowingTimelineUrl(url, scope.location.href)) {
        return;
      }

      // `responseText` throws for binary response types, so it is never read
      // unless the page asked for text.
      if (xhr.responseType === "json") {
        publish(xhr.response);
        return;
      }

      if (xhr.responseType === "" || xhr.responseType === "text") {
        publishText(xhr.responseText);
      }
    } catch {
      // Observation is best-effort and must never affect the page.
    }
  };

  const patchedOpen: XhrPrototype["open"] = function (method, url, ...rest) {
    try {
      requestUrls.set(this, typeof url === "string" ? url : url.href);
    } catch {
      // A non-extensible or proxied instance simply stays unobserved.
    }

    return originalOpen.apply(this, [method, url, ...rest]);
  };

  const patchedSend: XhrPrototype["send"] = function (...args) {
    try {
      if (!listening.has(this)) {
        // One persistent listener observes every reuse of this XHR instance
        // without accumulating duplicate callbacks across repeated sends.
        this.addEventListener("load", () => {
          observe(this);
        });
        listening.add(this);
      }
    } catch {
      // Observation is optional; the request must proceed either way.
    }

    return originalSend.apply(this, args);
  };

  wrapped.add(patchedOpen);
  wrapped.add(patchedSend);
  prototype.open = patchedOpen;
  prototype.send = patchedSend;

  return () => {
    if (prototype.open === patchedOpen) {
      prototype.open = originalOpen;
    }

    if (prototype.send === patchedSend) {
      prototype.send = originalSend;
    }
  };
}

function noop(): void {
  // Intentionally empty.
}

// Auto-install only inside a real X page; importing this module elsewhere (for
// example in a test) must have no side effect.
if (typeof window !== "undefined" && isXHost(window.location.hostname)) {
  installFollowingDataObserver(window);
}
