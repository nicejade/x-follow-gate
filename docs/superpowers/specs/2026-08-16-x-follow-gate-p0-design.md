# X Follow Gate — P0 Design

**Date:** 2026-08-16  
**Status:** Approved  
**Scope:** Chrome extension, P0 only (non-mutual unfollow + whitelist)  
**Audience:** Personal / small trusted circle (unpacked or private zip; not Chrome Web Store)

---

## 1. Problem & Goals

Help the signed-in X.com user inspect Following relationships and unfollow accounts that do not follow back, with a whitelist, without a separate login, and with strong safeguards against X anti-automation / rate-limit enforcement.

### P0 success criteria

- Reuse the existing x.com browser session (no second login flow).
- Sync Following by **simulating human scrolling** on the Following page (no background GraphQL pagination storms).
- Compute non-mutual candidates locally; support whitelist.
- Unfollow only via an explicit preview → confirm → slow queue.
- Default posture is Safe; safety floors cannot be bypassed by UI.

### Out of scope (later)

- P1: inactivity / zombie detection  
- P2: keyword / blacklist rules  
- Read-only CLI over exported data  
- Multi-account parallel runs  
- Cloud sync or remote config  

---

## 2. Form Factor Decision

| Option | Verdict |
|--------|---------|
| **Chrome MV3 extension** | **Chosen** — native session reuse, human-like page context, Side Panel UX |
| CLI as primary | Rejected — auth/fingerprint risk; optional later as read-only |
| Official X API | Rejected — auth model and limits do not match “use x.com session” |

---

## 3. Architecture

```text
┌─────────────────────────────────────────────┐
│  Side Panel UI                               │
│  Insight / Cleanup / Settings                │
└──────────────────┬──────────────────────────┘
                   │ chrome.runtime messaging
┌──────────────────▼──────────────────────────┐
│  Service Worker                              │
│  · chrome.storage.local = source of truth    │
│  · chrome.alarms = unfollow scheduling       │
│  · top-level listeners; no memory-only state │
└──────────────────┬──────────────────────────┘
                   │
┌──────────────────▼──────────────────────────┐
│  Content Script (https://x.com/*)            │
│  · progressive scroll sync on /following     │
│  · passive capture of page-loaded user data  │
│  · single unfollow per SW command            │
│  · auth / account-switch detection           │
└─────────────────────────────────────────────┘
```

### MV3 practices

- Ephemeral service worker: persist all queue/sync state in `chrome.storage.local`.
- Schedule unfollow ticks with `chrome.alarms`, not long `setInterval`.
- Register event listeners at top level in the service worker.
- Minimal permissions: `storage`, `alarms`, `sidePanel`, host access limited to `x.com` / `twitter.com`.
- Content script performs writes in page session context; SW never holds or exfiltrates cookies.

### Module boundaries

| Module | Responsibility |
|--------|----------------|
| `sidepanel/` | UI only; emits user intent; does not talk to X network directly |
| `background/` | Queue, alarms, storage, circuit breaker, coordination |
| `content/` | Scroll sync, response/DOM capture, one-shot unfollow, auth probe |
| `shared/` | Types, message protocol, pure P0 rule functions, safety floor constants |

Content never decides *when* the next unfollow happens.  
SW never performs friendship destroy without Content.

---

## 4. Read Path — Progressive Scroll Sync (Hard Rule)

**Forbidden:** Extension background code paging Following GraphQL at high rate.

**Required:** Open or focus `https://x.com/{self}/following`, then scroll like a human so the **page itself** loads the next chunks; the extension only observes and stores.

### Scroll session behavior

1. Side Panel → Sync Following.  
2. Open or reuse the Following tab; keep it visible when possible.  
3. Content starts a scroll session:
   - Each step scrolls ~40%–80% of viewport height (randomized).
   - Pause 1.5–4s between steps; occasional longer pause 6–12s.
   - Occasional slight reverse scroll / idle to avoid metronomic motion.
4. Prefer capturing relationship fields from page network responses as the timeline loads; DOM scrape is fallback/supplement only.
5. Dedupe into local `following` map; Side Panel shows live progress.
6. Stop on: end of list, user pause/stop, per-session scroll budget, or “no new items” streak.

### Read-path constraints

| Rule | Behavior |
|------|----------|
| Tab visibility | Following tab hidden ≥ 45s → auto-pause scroll |
| Session budget | Default ≤ 8 minutes or ≤ 120 scroll steps per round (whichever first); user may Continue |
| Mutual exclusion | Scroll sync and unfollow queue never run together |
| Stalls | 5 consecutive scroll steps with no new users → end round + explain |
| Storage | Local only; primary fields: userId, handle, name, avatar, `followedBy`, `syncedAt` |

---

## 5. Write Path — Unfollow Queue & Anti-Ban

Principle: **reads may be slow; writes must be extremely slow. Default Safe. On error, stop. Always pausable.**

### Gates

- No unfollow without generated candidates + explicit Start after preview.
- Global single-flight: at most one unfollow in flight.
- Requires an active x.com context for the actual destroy call.
- Default active hours (local): 09:00–23:00 (user-toggleable).
- Persistent Pause / Stop in UI; closing the panel must not accelerate the queue.

### Default limits (Balanced shown as optional preset; **Safe is default**)

| Preset | Interval band | /hour | /day | /session |
|--------|---------------|-------|------|----------|
| **Safe (default)** | 90–150s uniform | ≤ 5 | ≤ 20 | ≤ 10 |
| Balanced | 75–120s uniform | ≤ 8 | ≤ 30 | ≤ 15 |
| Custom | User-tunable | Clamped to floors below | same | same |

**Hard floors (`shared/safety.ts`, UI clamp):** min interval ≥ 60s; max hour ≤ 12; max day ≤ 40; max session ≤ 20. Custom cannot exceed these ceilings or break the min interval.

Interval scheduling: pick next delay uniformly inside the preset band; persist `nextAt`; fire via `chrome.alarms`.

### Circuit breaker

- HTTP 401 / 403 / 429 or 3 consecutive failures → pause queue, cooldown **60 minutes** (fixed P0 default), strong Side Panel banner, audit entry.
- Transient network failure: retry that item at most once; then skip and log; do not “catch up” by shortening delays.
- Logout or account switch → stop write queue intent; keep whitelist + settings.

### Audit

Append-only local log of recent unfollow attempts (timestamp, target, ok/fail, error code). No upload.

---

## 6. P0 Rule Logic

Candidate if:

```text
following[userId].followedBy === false
AND userId/handle not in whitelist
```

Whitelist matches on handle and/or userId. Whitelisted users never enter the unfollow queue.

---

## 7. UI / UX

### Shell

- Chrome **Side Panel** (~360–400px), not a tiny action popup.
- Top: product name **Follow Gate** + login indicator (ok / missing).
- Bottom: safety preset label + today’s unfollow count vs day cap.

### Tabs

1. **Insight**  
   - Metrics: Following count, synced count, non-mutual candidates, mutual rate.  
   - Primary: Sync Following (copy notes simulated scrolling).  
   - In progress: count + Pause; hint to keep Following tab foregrounded.

2. **Cleanup**  
   - Rule summary: “Not following back · whitelist excluded”.  
   - Selectable candidate list (avatar, name, @handle); default select all non-whitelisted.  
   - Whitelist manage entry.  
   - CTA: Preview & Start → confirm count, ETA from interval, safety preset.  
   - Running: current target, remaining, countdown to next action, Pause/Stop.

3. **Settings**  
   - Safe / Balanced / Custom (floors enforced).  
   - Whitelist, active hours, caps.  
   - Read-only audit log.

### Visual direction

- Dark, tool-like surface aligned with x.com night browsing (reduce context switch).
- One accent color for primary CTAs; avoid generic purple-gradient / cream-serif templates.
- List-first layout; no card stacks for decoration.
- Motion only for progress and state changes.

### Mutual exclusion UX

When sync is running, unfollow controls are disabled with reason (and vice versa).  
Circuit-breaker state uses a full-width warning bar.

---

## 8. Storage Schema

All keys in `chrome.storage.local`:

| Key | Purpose |
|-----|---------|
| `session` | Current X user id/handle, last auth probe time |
| `following` | Map of followed users + `followedBy` + `syncedAt` |
| `syncMeta` | Sync progress, likely-at-end flag, pause reason |
| `whitelist` | Handles / userIds |
| `candidates` | Optional preview selection snapshot |
| `unfollowQueue` | `status`, `items[]`, cursor, `nextAt`, session/day counters |
| `settings` | Preset, interval band, caps, active hours |
| `auditLog` | Recent unfollow results |

---

## 9. Message Protocol (illustrative)

**UI → SW:** `SYNC_START` | `SYNC_PAUSE` | `QUEUE_START` | `QUEUE_PAUSE` | `QUEUE_STOP` | `SETTINGS_UPDATE`  

**SW → Content:** `SCROLL_SESSION_START` | `SCROLL_SESSION_STOP` | `UNFOLLOW_ONE`  

**Content → SW:** `FOLLOWING_BATCH` | `SCROLL_STATUS` | `UNFOLLOW_RESULT` | `AUTH_STATUS`  

**SW → UI:** storage change notifications and/or `STATE_PATCH` (progress, countdown, alerts)

---

## 10. Error Handling Matrix

| Condition | Response |
|-----------|----------|
| Not logged in / account switch | Stop scroll + queue; red indicator; keep whitelist/settings |
| Scroll yields no new users × 5 steps | End sync round; tip (end or rate limit) |
| Unfollow 429 / 403 | Circuit break + cooldown + audit |
| Unfollow network blip | ≤1 retry; then skip + log |
| Following tab missing / hidden ≥ 45s | Pause scroll until visible (unless user Stopped) |
| SW killed mid-queue | Alarm wake restores from storage; still honor `nextAt` |
| Sync vs unfollow conflict | Reject second start with clear reason |

---

## 11. Testing & Acceptance (P0)

- Unit: pure rule filter, whitelist, day/session/hour cap edges, queue state machine.
- Manual: scroll-sync a real Following list segment; Safe-mode unfollow 1–2 accounts; verify interval, pause, and breaker copy.
- Do **not** automate bulk real-network unfollow in CI.

---

## 12. Primary User Journey

1. Log into x.com → open Follow Gate Side Panel.  
2. Sync Following (human-like scroll) → watch progress.  
3. Review non-mutual candidates; adjust selection / whitelist.  
4. Choose Safe → Preview & Start → confirm.  
5. Queue runs slowly; pause anytime; session cap stops and asks before continuing.

---

## 13. Open Implementation Notes

- Exact X GraphQL operation names and payload shapes are discovered at implementation time from the live Following page; treat them as unstable and isolate behind an adapter.
- Prefer response interception aligned with scroll-triggered loads; avoid inventing parallel paginators.
- Safety numeric floors may be tuned after self-use, but product defaults stay at Safe.

---

## Approval

- [x] Architecture + anti-ban (user OK)  
- [x] Progressive scroll read path (user OK)  
- [x] UI (user OK)  
- [x] Data model / modules / errors (user OK)  
- [x] User review of this written spec  

After spec approval → implementation plan via writing-plans skill.
