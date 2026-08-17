/**
 * Who is signed in, according to the page itself.
 *
 * The extension reuses the browser's existing x.com session, so it must never
 * guess an identity: a wrong answer would let the unfollow queue act as the
 * wrong account. The detector is therefore fail-closed. It returns `null` —
 * "unknown", which blocks every write operation — unless the readable sources
 * agree on one handle and a usable numeric id is present.
 *
 * Sources are chosen for stability rather than convenience:
 * - the profile link and the account switcher, which are keyed by long-lived
 *   `data-testid` values and are the same nodes a person clicks;
 * - the `twid` cookie, the only place the ISOLATED world can read the signed-in
 *   numeric id (page JavaScript variables belong to the MAIN world). It holds
 *   the user's own id, is read locally, and is never transmitted anywhere.
 *
 * Two page sources that disagree mean the account switcher is mid-flight, so the
 * answer is unknown rather than "probably the first one".
 */

import { normalizeHandle } from "@/shared/rules";
import type { AccountIdentity } from "@/shared/types";

/** X handles are 1-15 lowercase alphanumerics or underscores once normalized. */
const HANDLE_PATTERN = /^[a-z0-9_]{1,15}$/;
const TWID_PATTERN = /^u=([0-9]{1,32})$/;
const HANDLE_LABEL_PATTERN = /^@([A-Za-z0-9_]{1,15})$/;

const AVATAR_TESTID_PREFIX = "UserAvatar-Container-";
const PROFILE_LINK_SELECTOR = 'a[data-testid="AppTabBar_Profile_Link"]';
const ACCOUNT_SWITCHER_SELECTOR = '[data-testid="SideNavBar-AccountSwitcher"]';
const SIGNED_OUT_SELECTOR = '[data-testid="loginButton"], [data-testid="signupButton"]';

/** First path segments that can look like a handle but never identify a person. */
const RESERVED_PATH_SEGMENTS = new Set([
  "about",
  "account",
  "bookmarks",
  "communities",
  "compose",
  "download",
  "explore",
  "hashtag",
  "help",
  "home",
  "i",
  "intent",
  "jobs",
  "lists",
  "login",
  "logout",
  "messages",
  "notifications",
  "privacy",
  "search",
  "settings",
  "share",
  "signup",
  "topics",
  "tos",
]);

/**
 * Returns the signed-in identity, or `null` when it cannot be established with
 * confidence. Never throws: an unreadable document is simply unknown.
 */
export function detectAccount(document: Document): AccountIdentity | null {
  try {
    if (document.querySelector(SIGNED_OUT_SELECTOR) !== null) {
      return null;
    }

    const handles = collectHandles(document);
    const [handle] = handles;
    if (handles.size !== 1 || handle === undefined) {
      return null;
    }

    const userId = readUserId(document.cookie);

    return userId === null ? null : { userId, handle };
  } catch {
    return null;
  }
}

function collectHandles(document: Document): Set<string> {
  const handles = new Set<string>();

  const profileLink = document.querySelector(PROFILE_LINK_SELECTOR);
  addHandle(handles, readHandleFromHref(profileLink?.getAttribute("href")));

  const switcher = document.querySelector(ACCOUNT_SWITCHER_SELECTOR);
  if (switcher !== null) {
    const avatar = switcher.querySelector(`[data-testid^="${AVATAR_TESTID_PREFIX}"]`);
    addHandle(handles, avatar?.getAttribute("data-testid")?.slice(AVATAR_TESTID_PREFIX.length));
    addHandle(handles, readHandleFromLabel(switcher));
  }

  return handles;
}

function addHandle(handles: Set<string>, candidate: string | null | undefined): void {
  if (typeof candidate !== "string") {
    return;
  }

  const handle = normalizeHandle(candidate);
  if (HANDLE_PATTERN.test(handle)) {
    handles.add(handle);
  }
}

/** Reads `/{handle}` from a same-origin path, ignoring query and fragment. */
function readHandleFromHref(href: string | null | undefined): string | null {
  if (typeof href !== "string" || !href.startsWith("/")) {
    return null;
  }

  const segment = href.slice(1).split(/[/?#]/)[0] ?? "";

  return segment !== "" && !RESERVED_PATH_SEGMENTS.has(segment.toLowerCase()) ? segment : null;
}

/** The switcher renders the handle as its own `@handle` label. */
function readHandleFromLabel(switcher: Element): string | null {
  for (const node of switcher.querySelectorAll("span, div")) {
    const match = HANDLE_LABEL_PATTERN.exec(node.textContent?.trim() ?? "");
    if (match?.[1] !== undefined) {
      return match[1];
    }
  }

  return null;
}

/** Reads the signed-in numeric id from the `twid` cookie (`u=<id>`). */
function readUserId(cookie: unknown): string | null {
  if (typeof cookie !== "string") {
    return null;
  }

  for (const entry of cookie.split(";")) {
    const separator = entry.indexOf("=");
    if (separator < 0 || entry.slice(0, separator).trim() !== "twid") {
      continue;
    }

    let value = entry.slice(separator + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      return null;
    }

    return TWID_PATTERN.exec(value.replace(/^"(.*)"$/, "$1"))?.[1] ?? null;
  }

  return null;
}
