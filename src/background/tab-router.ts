/**
 * Routing for the one visible X tab the unfollow queue writes through.
 *
 * Every write happens in a tab the user can see, in their own session, one at a
 * time. Three rules make that true and are the reason this module exists:
 *
 * 1. **Reuse, never multiply.** An existing X tab is navigated to the target
 *    profile. A second tab would let two pages act at once, which is exactly the
 *    pattern automated-abuse detection looks for.
 * 2. **Open only when necessary.** A write needs an X context. When the user has
 *    none open, one tab is created and brought to the front — the same pattern
 *    the sync path already uses — instead of pausing with no explanation.
 * 3. **Readiness is proven, not assumed.** The tab must actually be on the
 *    target profile and finished loading before a command is issued, and the
 *    command counts as delivered only when the content script acknowledges it.
 */

import type { ExtensionMessage } from "@/shared/messages";
import { normalizeHandle } from "@/shared/rules";
import type { AccountIdentity, FollowingUser } from "@/shared/types";

const X_HOSTS = ["x.com", "twitter.com"] as const;

/** Bounded readiness poll: 20 × 250 ms ≈ 5 s, then the tick gives up. */
export const READINESS_ATTEMPTS = 20;
export const READINESS_INTERVAL_MS = 250;

export type TabRoute = { ok: true; tabId: number } | { ok: false; reason: "missing-tab" };

export interface RouteOptions {
  /** Injected so the readiness poll is deterministic under test. */
  wait?: (delayMs: number) => Promise<void>;
  attempts?: number;
  intervalMs?: number;
}

export interface SendUnfollowOptions {
  attempts?: number;
  retryDelayMs?: number;
  wait?: (delayMs: number) => Promise<void>;
}

interface TabLike {
  id?: number;
  url?: string;
  active?: boolean;
  status?: string;
}

export function profileUrl(handle: string): string {
  return `https://x.com/${normalizeHandle(handle)}`;
}

function parseXUrl(url: string | undefined): URL | null {
  if (typeof url !== "string" || url === "") {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (parsed.protocol !== "https:") {
    return null;
  }

  const isXHost = X_HOSTS.some(
    (host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`),
  );

  return isXHost ? parsed : null;
}

export function isXTabUrl(url: string | undefined): boolean {
  return parseXUrl(url) !== null;
}

/** True only for the profile root; a status or `/following` page is not it. */
export function isProfileUrl(url: string | undefined, handle: string): boolean {
  const parsed = parseXUrl(url);
  if (parsed === null) {
    return false;
  }

  const path = parsed.pathname.replace(/\/+$/, "").toLowerCase();

  return path === `/${normalizeHandle(handle)}`;
}

/**
 * Picks the tab to write through: one already showing the profile, else the
 * active X tab, else the first X tab. Returns `null` when the user has no X
 * context open.
 */
function pickTab(tabs: TabLike[], handle: string): TabLike | null {
  const candidates = tabs.filter((tab) => typeof tab.id === "number" && isXTabUrl(tab.url));

  return (
    candidates.find((tab) => isProfileUrl(tab.url, handle)) ??
    candidates.find((tab) => tab.active === true) ??
    candidates[0] ??
    null
  );
}

async function queryXTabs(): Promise<TabLike[]> {
  return await chrome.tabs.query({ url: ["https://x.com/*", "https://twitter.com/*"] });
}

/**
 * Ensures there is exactly one X tab to write through, creating one when the
 * user has none open. Mirrors the sync coordinator's `ensureFollowingTab`.
 */
async function ensureWriteTab(handle: string): Promise<number | null> {
  const url = profileUrl(handle);

  try {
    const existing = pickTab(await queryXTabs(), handle);
    if (existing !== null && typeof existing.id === "number") {
      await chrome.tabs.update(
        existing.id,
        isProfileUrl(existing.url, handle) ? { active: true } : { url, active: true },
      );

      return existing.id;
    }

    const created = await chrome.tabs.create({ url, active: true });

    return typeof created.id === "number" ? created.id : null;
  } catch {
    return null;
  }
}

/**
 * Waits until the tab is on the target profile and has finished loading.
 *
 * A tab that navigates elsewhere (an interstitial, a login flow) never becomes
 * ready, so the caller pauses instead of clicking on an unknown page.
 */
async function waitForProfile(
  tabId: number,
  handle: string,
  options: Required<Pick<RouteOptions, "wait" | "attempts" | "intervalMs">>,
): Promise<boolean> {
  for (let attempt = 0; attempt < options.attempts; attempt += 1) {
    let tab: TabLike;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      // The user closed the tab mid-navigation.
      return false;
    }

    if (isProfileUrl(tab.url, handle) && tab.status === "complete") {
      return true;
    }

    await options.wait(options.intervalMs);
  }

  return false;
}

/**
 * Brings the single write tab to the target profile.
 *
 * A tab that is already on the profile is only activated, so a queue that walks
 * back to the same account does not reload the page unnecessarily.
 */
export async function routeToProfile(
  handle: string,
  options: RouteOptions = {},
): Promise<TabRoute> {
  const poll = {
    wait: options.wait ?? defaultWait,
    attempts: options.attempts ?? READINESS_ATTEMPTS,
    intervalMs: options.intervalMs ?? READINESS_INTERVAL_MS,
  };

  const tabId = await ensureWriteTab(handle);
  if (tabId === null) {
    return { ok: false, reason: "missing-tab" };
  }

  return (await waitForProfile(tabId, handle, poll))
    ? { ok: true, tabId }
    : { ok: false, reason: "missing-tab" };
}

function defaultWait(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

/**
 * Issues the one command that may unfollow the target.
 *
 * A rejected send means the content script is not listening in that tab, which
 * the caller treats as a missing context rather than a failed unfollow.
 */
export async function sendUnfollowOne(
  tabId: number,
  target: FollowingUser,
  account: AccountIdentity,
  options: SendUnfollowOptions = {},
): Promise<boolean> {
  const message: ExtensionMessage = { type: "UNFOLLOW_ONE", target, account };
  const attempts = options.attempts ?? 4;
  const retryDelayMs = options.retryDelayMs ?? 500;
  const wait = options.wait ?? defaultWait;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await chrome.tabs.sendMessage(tabId, message);

      return true;
    } catch {
      if (attempt < attempts - 1) {
        await wait(retryDelayMs);
      }
    }
  }

  return false;
}
