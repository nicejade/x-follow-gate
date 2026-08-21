/**
 * One unfollow, performed the way a person would: two clicks on the visible
 * profile UI, never a friendship/GraphQL call.
 *
 * The driver is fail-closed. Any ambiguity — the wrong profile, the wrong
 * account, a missing control, a challenge sheet, a timeout — returns a typed
 * failure and does not guess. At most two clicks are issued per attempt.
 */

import { detectAccount } from "@/content/auth-detector";
import { normalizeHandle } from "@/shared/rules";
import { pickProfileDwellMs } from "@/shared/safety";
import type {
  AccountIdentity,
  FollowingUser,
  UnfollowResult,
  UnfollowResultCode,
} from "@/shared/types";

export const UNFOLLOW_WAIT_MS = 10_000;

const FOLLOWING_TEST_IDS = ["unfollow", "unFollowButton"] as const;
const FOLLOW_TEST_IDS = ["follow", "followButton"] as const;
const DIALOG_SELECTOR =
  '[data-testid="confirmationSheetDialog"], [role="alertdialog"], [role="dialog"]';
const CONFIRM_TEST_ID = "confirmationSheetConfirm";

// English alternatives keep `\b` so "follow" does not match "Following".
// CJK alternatives must not use `\b`: JS word boundaries only see ASCII `\w`.
const FOLLOWING_NAME = /^(following\b|正在关注)/i;
const FOLLOW_NAME = /^(follow\b|关注)/i;
const UNFOLLOW_NAME = /^(unfollow\b|取消关注)/i;
// Challenge copy must stay specific: a bare「验证」matches ordinary Chinese UI
// (email verified, etc.) and would false-trip the circuit breaker.
const CHALLENGE_TEXT =
  /unusual activity|suspicious|verify (you are|it.?s you)|confirm your identity|异常活动|可疑活动|确认你的身份|验证你是|验证身份|人机验证|请验证你的/i;
const RATE_LIMIT_TEXT = /rate limit|try again later|too many requests|稍后重试|操作过于频繁/i;

export interface UnfollowEnvironment {
  document: Document;
  location: Pick<Location, "pathname" | "href">;
  detectAccount: (document: Document) => AccountIdentity | null;
  click: (element: Element) => void;
  waitFor: (predicate: () => boolean, timeoutMs: number) => Promise<boolean>;
  /** Injected so confirm-sheet dwells are deterministic under test. */
  sleep: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

export interface UnfollowOptions {
  /** Settings band reused for the confirm-sheet pause before「取消关注」. */
  interval?: { minSec: number; maxSec: number };
  random?: () => number;
}

export function createBrowserUnfollowEnvironment(
  documentRef: Document = document,
  locationRef: Pick<Location, "pathname" | "href"> = location,
): UnfollowEnvironment {
  return {
    document: documentRef,
    location: locationRef,
    detectAccount,
    click: (element) => {
      if (element instanceof HTMLElement) {
        element.click();
      }
    },
    waitFor: (predicate, timeoutMs) => waitForMutation(documentRef, predicate, timeoutMs),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    timeoutMs: UNFOLLOW_WAIT_MS,
  };
}

export async function unfollowOne(
  target: FollowingUser,
  env: UnfollowEnvironment,
  account: AccountIdentity,
  options: UnfollowOptions = {},
): Promise<UnfollowResult> {
  const handle = normalizeHandle(target.handle);
  const base = { userId: target.userId, handle };

  const blocked = inspectBlockingState(env);
  if (blocked !== null) {
    return outcome(base, blocked);
  }

  const signedIn = env.detectAccount(env.document);
  if (signedIn === null) {
    return outcome(base, "auth-required");
  }
  if (signedIn.userId !== account.userId || signedIn.handle !== account.handle) {
    return outcome(base, "account-mismatch");
  }

  if (!isTargetProfile(env.location.pathname, handle)) {
    return outcome(base, "target-mismatch");
  }

  if (findFollowControl(env.document) !== null && findFollowingControl(env.document) === null) {
    return outcome(base, "already-unfollowed", true);
  }

  const following = findFollowingControl(env.document);
  if (following === null) {
    return outcome(base, "control-missing");
  }

  env.click(following);

  const dialogReady = await env.waitFor(
    () =>
      inspectBlockingState(env) !== null ||
      findConfirmControl(env.document) !== null ||
      (findFollowControl(env.document) !== null && findFollowingControl(env.document) === null),
    env.timeoutMs ?? UNFOLLOW_WAIT_MS,
  );

  const afterClick = inspectBlockingState(env);
  if (afterClick !== null) {
    return outcome(base, afterClick);
  }

  if (!dialogReady) {
    return outcome(base, "confirmation-missing");
  }

  if (findFollowControl(env.document) !== null && findFollowingControl(env.document) === null) {
    return outcome(base, "already-unfollowed", true);
  }

  if (options.interval !== undefined) {
    await env.sleep(pickProfileDwellMs(options.interval, options.random ?? Math.random));
    const afterDwell = inspectBlockingState(env);
    if (afterDwell !== null) {
      return outcome(base, afterDwell);
    }
  }

  const confirmAfterDwell = findConfirmControl(env.document);
  if (confirmAfterDwell === null) {
    return outcome(base, "confirmation-missing");
  }

  env.click(confirmAfterDwell);

  const verified = await env.waitFor(
    () =>
      inspectBlockingState(env) !== null ||
      (findFollowControl(env.document) !== null && findFollowingControl(env.document) === null),
    env.timeoutMs ?? UNFOLLOW_WAIT_MS,
  );

  const afterConfirm = inspectBlockingState(env);
  if (afterConfirm !== null) {
    return outcome(base, afterConfirm);
  }

  if (!verified) {
    return outcome(base, "verification-failed");
  }

  return outcome(base, "success", true);
}

function outcome(
  base: { userId: string; handle: string },
  code: UnfollowResultCode,
  ok = false,
): UnfollowResult {
  return { ...base, ok, code };
}

function inspectBlockingState(env: UnfollowEnvironment): UnfollowResultCode | null {
  if (isAuthRequired(env)) {
    return "auth-required";
  }

  const text = env.document.body?.innerText ?? env.document.body?.textContent ?? "";
  if (CHALLENGE_TEXT.test(text) || /\/i\/flow\//.test(env.location.href)) {
    return "challenge";
  }
  if (RATE_LIMIT_TEXT.test(text)) {
    return "rate-limited";
  }

  return null;
}

function isAuthRequired(env: UnfollowEnvironment): boolean {
  return (
    env.document.querySelector('[data-testid="loginButton"], [data-testid="signupButton"]') !==
      null || /\/(login|i\/flow\/login)/i.test(env.location.pathname + env.location.href)
  );
}

export function isTargetProfile(pathname: string, handle: string): boolean {
  const normalized = pathname.replace(/\/+$/, "").toLowerCase();

  return normalized === `/${normalizeHandle(handle)}`;
}

function findFollowingControl(documentRef: Document): Element | null {
  return (
    findButtonByTestIds(documentRef, FOLLOWING_TEST_IDS) ??
    findButtonByName(documentRef, FOLLOWING_NAME)
  );
}

function findFollowControl(documentRef: Document): Element | null {
  return (
    findButtonByTestIds(documentRef, FOLLOW_TEST_IDS) ?? findButtonByName(documentRef, FOLLOW_NAME)
  );
}

function findConfirmControl(documentRef: Document): Element | null {
  const dialog = documentRef.querySelector(DIALOG_SELECTOR);
  if (dialog === null) {
    return null;
  }

  const byTestId = dialog.querySelector(`[data-testid="${CONFIRM_TEST_ID}"]`);
  if (byTestId instanceof Element) {
    return byTestId;
  }

  for (const button of dialog.querySelectorAll("button")) {
    if (UNFOLLOW_NAME.test(accessibleName(button))) {
      return button;
    }
  }

  return null;
}

function findButtonByTestIds(documentRef: Document, testIds: readonly string[]): Element | null {
  for (const testId of testIds) {
    const match = documentRef.querySelector(`button[data-testid="${testId}"]`);
    if (match !== null && !isInsideDialog(match)) {
      return match;
    }
  }

  return null;
}

function findButtonByName(documentRef: Document, pattern: RegExp): Element | null {
  for (const button of documentRef.querySelectorAll("button")) {
    if (isInsideDialog(button)) {
      continue;
    }

    const name = accessibleName(button);
    if (pattern.test(name) && (pattern !== FOLLOW_NAME || !FOLLOWING_NAME.test(name))) {
      return button;
    }
  }

  return null;
}

function isInsideDialog(element: Element): boolean {
  return element.closest(DIALOG_SELECTOR) !== null;
}

function accessibleName(element: Element): string {
  const labelled = element.getAttribute("aria-label")?.trim();
  if (labelled) {
    return labelled;
  }

  return (element.textContent ?? "").replace(/\s+/g, " ").trim();
}

function waitForMutation(
  documentRef: Document,
  predicate: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  if (predicate()) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    const root = documentRef.documentElement;
    const observer = new MutationObserver(() => {
      if (predicate()) {
        finish(true);
      }
    });

    const timer = setTimeout(() => {
      finish(false);
    }, timeoutMs);

    const finish = (matched: boolean): void => {
      observer.disconnect();
      clearTimeout(timer);
      resolve(matched);
    };

    observer.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
  });
}
