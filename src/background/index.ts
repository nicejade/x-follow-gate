/**
 * MV3 service-worker entry. Listeners are registered at module top level so a
 * restarted worker can handle the first event even before any async work
 * finishes. Persisted `chrome.storage.local` remains the only queue/sync state.
 */

import {
  applyUnfollowResult,
  dismissUnfollowCooldown,
  isUnfollowAlarm,
  pauseUnfollowQueue,
  runQueueTick,
  startUnfollowQueue,
  stopUnfollowQueue,
  UNFOLLOW_ALARM_NAME,
} from "@/background/queue";
import { loadState, recomputeCandidates, removeFollowingUsers, updateState } from "@/background/store";
import {
  applyAuthStatus,
  applyScrollStatus,
  ingestFollowingBatch,
  pauseSync,
  refreshAuth,
  startSync,
  stopSync,
} from "@/background/sync-coordinator";
import { assertNever, isExtensionMessage } from "@/shared/messages";
import { clampSettings } from "@/shared/safety";
import type { QueuePauseReason } from "@/shared/types";

export interface PublicError {
  code: string;
}

export type MessageResponse = { ok: true; result: unknown } | { ok: false; error: PublicError };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function toPublicError(error: unknown): PublicError {
  if (isRecord(error) && typeof error.code === "string") {
    return { code: error.code };
  }

  return { code: "internal-error" };
}

const CLIENT_QUEUE_PAUSE = new Set<QueuePauseReason>(["user"]);

export async function handleMessage(
  message: unknown,
  sender: chrome.runtime.MessageSender = {},
): Promise<unknown> {
  if (!isExtensionMessage(message)) {
    throw { code: "unknown-message" };
  }

  switch (message.type) {
    case "STATE_GET":
      return await loadState();
    case "SYNC_START":
      return await startSync();
    case "SYNC_PAUSE":
      await pauseSync(message.reason);
      return { paused: true };
    case "SYNC_STOP":
      await stopSync();
      return { stopped: true };
    case "FOLLOWING_BATCH":
      await ingestFollowingBatch(message.users);
      return { ingested: message.users.length };
    case "FOLLOWING_REMOVE":
      await updateState((state) => removeFollowingUsers(state, message.userIds));
      return { removed: message.userIds.length };
    case "SCROLL_STATUS":
      await applyScrollStatus(message.status);
      return { applied: true };
    case "AUTH_STATUS":
      await applyAuthStatus(message.account, sender.tab?.id ?? -1);
      return { applied: true };
    case "AUTH_REFRESH":
      return await refreshAuth();
    case "QUEUE_START":
      return await startUnfollowQueue(message.userIds);
    case "QUEUE_PAUSE":
      if (!CLIENT_QUEUE_PAUSE.has(message.reason)) {
        throw { code: "unknown-message" };
      }
      await pauseUnfollowQueue(message.reason);
      return { paused: true };
    case "QUEUE_STOP":
      await stopUnfollowQueue();
      return { stopped: true };
    case "QUEUE_DISMISS_COOLDOWN":
      return await dismissUnfollowCooldown();
    case "UNFOLLOW_RESULT":
      return await applyUnfollowResult(message.result);
    case "UNFOLLOW_READY":
      return { ready: true };
    case "SETTINGS_UPDATE":
      await updateState((state) => ({ ...state, settings: clampSettings(message.settings) }));
      return { updated: true };
    case "WHITELIST_UPDATE":
      await updateState((state) => recomputeCandidates({ ...state, whitelist: message.entries }));
      return { updated: true };
    case "AUTH_PROBE":
    case "SCROLL_SESSION_START":
    case "SCROLL_SESSION_PAUSE":
    case "SCROLL_SESSION_STOP":
    case "UNFOLLOW_ONE":
      // Worker → content only. A forged client copy is ignored.
      return { ignored: true };
    default:
      return assertNever(message);
  }
}

/**
 * Restores the unfollow alarm after a worker restart without executing a tick.
 * Paused and stopped queues stay idle.
 */
export async function restoreSchedule(now: number = Date.now()): Promise<void> {
  const state = await loadState();
  const queue = state.unfollowQueue;

  if (queue.status === "cooldown" && queue.cooldownUntil !== null && queue.cooldownUntil > now) {
    // The breaker has to demote itself when its window closes, even across a
    // worker restart. Without this alarm the panel would keep reporting a
    // cooldown that already expired, and Start would stay unavailable.
    await chrome.alarms.create(UNFOLLOW_ALARM_NAME, { when: queue.cooldownUntil });
    return;
  }

  if (queue.status !== "running" || queue.nextAt === null) {
    await chrome.alarms.clear(UNFOLLOW_ALARM_NAME);
    return;
  }

  await chrome.alarms.create(UNFOLLOW_ALARM_NAME, {
    when: Math.max(queue.nextAt, now),
  });
}

export async function handleAlarm(alarm: { name: string }): Promise<void> {
  if (!isUnfollowAlarm(alarm.name)) {
    return;
  }

  await runQueueTick();
}

export async function openSidePanel(windowId: number | undefined): Promise<void> {
  if (typeof windowId !== "number") {
    return;
  }

  await chrome.sidePanel.open({ windowId });
}

export function registerBackgroundListeners(): void {
  chrome.runtime.onInstalled.addListener(() => {
    void restoreSchedule();
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    handleMessage(message, sender)
      .then((result) => sendResponse({ ok: true, result } satisfies MessageResponse))
      .catch((error: unknown) =>
        sendResponse({ ok: false, error: toPublicError(error) } satisfies MessageResponse),
      );

    return true;
  });

  chrome.alarms.onAlarm.addListener((alarm) => {
    void handleAlarm(alarm);
  });

  chrome.action.onClicked.addListener((tab) => {
    void openSidePanel(tab.windowId);
  });

  chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
    if (changeInfo.status === "complete") {
      void restoreSchedule();
    }
  });
}

registerBackgroundListeners();
