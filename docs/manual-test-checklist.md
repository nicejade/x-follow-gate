# Follow Gate P0 — Manual Acceptance Checklist

Record Chrome version and pass/fail for each item. Do not bulk-unfollow a real account.

**Chrome version:** _______________  
**Date:** _______________  
**Account used:** _______________ (prefer a disposable test account for writes)

## Artifact inspection (before loading)

- [ ] `dist/manifest.json` has no `cookies`, `<all_urls>`, `webRequest`, or remotely hosted scripts
- [ ] Host permissions are only `https://x.com/*` and `https://twitter.com/*`
- [ ] `tests/fixtures/following-response.json` is synthetic / de-identified (`__provenance`)
- [ ] No source map contains captured real user payloads

## Read-only

1. [ ] Sign in to x.com, open Follow Gate Side Panel (login indicator green / “已登录”)
2. [ ] 洞察 → **同步 Following**; Following tab opens or is focused
3. [ ] Scrolling is progressive and irregular (not a metronome)
4. [ ] Hide the Following tab ≥45s → panel shows hidden pause copy
5. [ ] Bring the tab back / continue → counts increase without duplicates
6. [ ] DevTools Network: no extension-owned Following GraphQL pagination (only page-triggered loads while scrolling)
7. [ ] 清理 lists only explicit non-followers; whitelist removes a row
8. [ ] `chrome://extensions` → Service worker **Reload** → Side Panel still shows persisted counts

## Write (minimum risk, after read-only passes)

Use Safe preset. Select **exactly one** expendable candidate.

1. [ ] 预览并开始 shows count, 安全, 90–150s, ETA, and the zero-risk disclaimer
2. [ ] 确认并开始
3. [ ] Existing X tab navigates to that profile (no second tab)
4. [ ] One Following click, one Unfollow confirmation
5. [ ] Audit log records the result; no second unfollow before `nextAt`
6. [ ] 暂停 / 停止 does not issue another real unfollow

If a challenge, login wall, or rate-limit sheet appears: the queue must **pause/cooldown** and must not offer “ignore and continue”.

## Notes

Observed result:

```
(item number, pass/fail, notes)
```
