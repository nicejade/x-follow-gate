# Editable unfollow interval (2026-08-21)

## Goal

Default unfollow spacing is **3–12 seconds**. The interval is **independently editable** in Settings (any safety preset). The same band drives the profile dwell before clicking unfollow.

## Decisions

- **Presets:** Safe and Balanced only lock hourly / daily / session caps. Interval is never overwritten by switching presets.
- **Defaults:** New installs use `intervalMinSec: 3`, `intervalMaxSec: 12`.
- **Hard floor:** `HARD_LIMITS.minIntervalSec` stays **2**. Values below 2 clamp to 2; `max` is raised to `min` when needed.
- **UI:** 「取关间隔」 min/max inputs always visible under 设置, separate from 安全档位.
- **Execution:** `UNFOLLOW_ONE` carries `intervalMinSec` / `intervalMaxSec`; the content script samples dwell from that band.
- **Watchdog:** In-flight deadline scales with `intervalMaxSec`.

## Out of scope

- Editable hourly/daily/session caps in the Custom UI beyond existing draft/clamp behavior.
