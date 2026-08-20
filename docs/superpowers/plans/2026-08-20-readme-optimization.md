# README Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the English README with a best-practice product doc and add a full Chinese mirror covering purpose, features, usage, and development.

**Architecture:** Documentation-only change. `README.md` is the English primary; `README.zh-CN.md` is a structural mirror with top mutual links. Feature numbers and strategy names are verified against `src/shared/safety.ts` and Settings labels before publish.

**Tech Stack:** Markdown only (no product code). Verify constants with ripgrep / file reads against TypeScript sources.

**Spec:** `docs/superpowers/specs/2026-08-20-readme-design.md`

## Global Constraints

- Files: `README.md` (EN) + `README.zh-CN.md` (ZH); top language switcher on both.
- Required sections in order: title/one-liner → What it does → Features → Usage → Development → short Disclaimer.
- Remove: permissions table, Recovery runbook, Out of scope, full Scripts list, long “How it works”.
- No screenshots; no `CONTRIBUTING.md`; no deep links to `docs/superpowers/` by default.
- Safe wording must match `PRESET_LIMITS.safe`: interval **2–10s**, hourly **5**, daily **20**, session **10**.
- Strategies (OR): not following back; non-blue verified; protected; low tweet count (`statusesCount < 10`); follow-ratio (`friendsCount >= 100` and `friendsCount >= followersCount * 1.2`); whitelist always excludes; null fields never match.
- Do not claim X will never rate-limit; phrase as risk reduction only.
- EN/ZH must keep the same section order and bullet inventory.
- Do not change extension code or other docs in this plan.

---

## File map

| File | Responsibility |
|------|----------------|
| `README.md` | English primary README (rewrite in place) |
| `README.zh-CN.md` | Full Chinese mirror (create) |

---

### Task 1: Verify constants against code

**Files:**
- Read: `src/shared/safety.ts` (`PRESET_LIMITS.safe`)
- Read: `src/shared/rules.ts` (`LOW_TWEET_COUNT_THRESHOLD`, `FOLLOW_RATIO_*`, `SCAN_STRATEGY_LABELS`)
- Read: `src/sidepanel/views/SettingsView.tsx` (`SCAN_STRATEGY_OPTIONS` labels)

**Interfaces:**
- Produces: confirmed numbers/labels for Task 2–3 copy (no code changes)

- [ ] **Step 1: Confirm Safe preset numbers**

Run:

```bash
rg -n "PRESET_LIMITS|intervalMinSec|hourlyCap|dailyCap|sessionCap" src/shared/safety.ts | head -40
```

Expected: `safe` block shows `intervalMinSec: 2`, `intervalMaxSec: 10`, `hourlyCap: 5`, `dailyCap: 20`, `sessionCap: 10`.

- [ ] **Step 2: Confirm strategy thresholds and Settings labels**

Run:

```bash
rg -n "LOW_TWEET_COUNT_THRESHOLD|FOLLOW_RATIO_MIN_FOLLOWING|FOLLOW_RATIO_MULTIPLIER|SCAN_STRATEGY_OPTIONS" src/shared/rules.ts src/sidepanel/views/SettingsView.tsx
```

Expected:

- `LOW_TWEET_COUNT_THRESHOLD = 10`
- `FOLLOW_RATIO_MIN_FOLLOWING = 100`
- `FOLLOW_RATIO_MULTIPLIER = 1.2`
- Settings labels include 对方未回关 / 对方非蓝标 / 对方已锁定 / 推文极少 / 关注远大于粉丝

- [ ] **Step 3: Commit nothing yet**

This task is verification only. If numbers differ from the spec, stop and update the spec + this plan before writing READMEs.

---

### Task 2: Rewrite English `README.md`

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: verified constants from Task 1
- Produces: final English README content below

- [ ] **Step 1: Replace `README.md` with the following exact content**

```markdown
# Follow Gate

[English](README.md) | [中文](README.zh-CN.md)

Local-only Chrome MV3 extension that inspects your signed-in X.com Following list, finds cleanup candidates with configurable strategies, and unfollows them through a conservative, pausable queue.

Personal / trusted-circle tool. Not published to the Chrome Web Store.

## What it does

Follow Gate reuses your existing x.com browser session—no second login and no backend. It syncs Following by scrolling the Following page like a person and observing page-loaded relationship data (it does not page Following GraphQL itself). Candidates are computed locally from scan strategies you enable, then reviewed in Cleanup and run one-at-a-time through a rate-limited queue. All data stays in `chrome.storage.local`.

## Features

- **Local and minimal permissions** — No server, analytics, or remote config. Does not request `cookies`, `<all_urls>`, or `webRequest`.
- **Multi-strategy scan (OR)** — Independently toggle: not following back; non-blue verified; protected/private; very few posts (`statusesCount < 10`); following far exceeds followers (`friendsCount >= 100` and `friendsCount >= followersCount × 1.2`). Whitelist always excludes. Missing fields never match.
- **Safety rate limits** — Default **Safe**: 2–10s between actions, ≤5/hour, ≤20/day, ≤10/session. Balanced and Custom exist; hard floors cannot be bypassed in the UI.
- **Anti-abuse posture** — Randomized scroll pacing; one visible-profile unfollow at a time; Pause / Stop anytime; cooldown on auth or rate-limit-like failures.
- **Reviewable cleanup** — Preview candidates with match reasons; confirm before enqueue; queue stays pausable.

## Usage

```bash
pnpm install && pnpm build
```

1. Open `chrome://extensions`
2. Enable **Developer mode** → **Load unpacked** → select the `dist/` directory
3. Sign in to [x.com](https://x.com) as usual
4. Open the Side Panel from the Follow Gate action

Requires Chrome 114+ and [pnpm](https://pnpm.io/installation) 10+.

**Main flow**

1. **Insight** — Sync Following
2. **Settings** — Choose scan strategies and safety preset (recommended: **Safe**)
3. **Cleanup** — Preview → confirm → queue runs

If anything looks wrong: **Pause**, wait, reload the extension if needed. Never export cookies.

## Development

```bash
pnpm install
pnpm dev          # watch build
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

| Path | Role |
|------|------|
| `src/sidepanel` | Side Panel UI |
| `src/background` | Queue, alarms, storage coordination |
| `src/content` | Following scroll sync and in-page unfollow |
| `src/shared` | Types, scan rules, safety constants |
| `tests/` | Vitest |

PRs: keep changes small and focused; update related tests with behavior changes; explain *why* in the PR description.

## Disclaimer

No automation can guarantee that X will not rate-limit or restrict an account. Follow Gate only reduces risk. Prefer the Safe preset. Never export cookies, headers, or tokens.
```

- [ ] **Step 2: Sanity-check removed sections**

Run:

```bash
rg -n "Permissions|Recovery|Out of scope|How it works|webRequest|alarms" README.md
```

Expected:

- No `## Permissions`, `## Recovery`, `## Out of scope`, or `## How it works` headings
- `webRequest` may appear only inside the Features bullet about permissions not requested
- `alarms` should not appear as a dedicated permissions table row (ok if absent entirely)

- [ ] **Step 3: Commit English README**

```bash
git add README.md
git commit -m "$(cat <<'EOF'
docs: rewrite English README for clarity

Focus on purpose, features, usage, and development; drop
permissions/recovery/out-of-scope detail that obscured the product.
EOF
)"
```

---

### Task 3: Add Chinese `README.zh-CN.md`

**Files:**
- Create: `README.zh-CN.md`

**Interfaces:**
- Consumes: English section inventory from Task 2 (same bullets/order)
- Produces: Chinese mirror below

- [ ] **Step 1: Create `README.zh-CN.md` with the following exact content**

```markdown
# Follow Gate

[English](README.md) | [中文](README.zh-CN.md)

本地运行的 Chrome MV3 扩展：在你已登录的 X.com 会话上检查 Following 列表，按可配置策略找出清理候选人，并通过保守、可暂停的队列取关。

面向个人 / 信任圈使用，不上架 Chrome Web Store。

## 它做什么

Follow Gate 复用浏览器里已有的 x.com 登录态——不二次登录、无后端。它在 Following 页模拟人类滚动同步关注列表，并观察页面已加载的关系数据（扩展不会自行分页 Following GraphQL）。候选人按你启用的扫描策略在本地计算，在 Cleanup 预览确认后，以限速队列逐个取关。数据只保存在 `chrome.storage.local`。

## 特征

- **本地与克制权限** — 无服务端、无分析、无远程配置。不申请 `cookies`、`<all_urls>`、`webRequest`。
- **多策略扫描（OR）** — 可独立开关：对方未回关；对方非蓝标；对方已锁定 / 私密；推文极少（`statusesCount < 10`）；关注远大于粉丝（`friendsCount >= 100` 且 `friendsCount >= followersCount × 1.2`）。白名单始终排除。缺字段不会误报。
- **安全限速** — 默认 **Safe**：动作间隔 2–10 秒，≤5/小时、≤20/天、≤10/会话。另有 Balanced / Custom；硬下限无法被界面绕过。
- **防滥用姿态** — 滚动节奏随机化；每次只在一个可见资料页取关；可随时 Pause / Stop；鉴权或类限流失败进入冷却。
- **可审可控** — 候选人预览并展示匹配原因；确认后才入队；队列始终可暂停。

## 如何使用

```bash
pnpm install && pnpm build
```

1. 打开 `chrome://extensions`
2. 开启 **开发者模式** → **加载已解压的扩展程序** → 选择 `dist/` 目录
3. 照常登录 [x.com](https://x.com)
4. 点击 Follow Gate 图标打开 Side Panel

需要 Chrome 114+ 与 [pnpm](https://pnpm.io/installation) 10+。

**主流程**

1. **Insight** — 同步 Following
2. **Settings** — 选择扫描策略与安全档位（推荐 **Safe**）
3. **Cleanup** — 预览 → 确认 → 队列执行

若有异常：**暂停**，等待，必要时重载扩展。切勿导出 cookies。

## 如何参与开发

```bash
pnpm install
pnpm dev          # 监听构建
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

| 路径 | 职责 |
|------|------|
| `src/sidepanel` | Side Panel UI |
| `src/background` | 队列、alarms、storage 协调 |
| `src/content` | Following 滚动同步与页内取关 |
| `src/shared` | 类型、扫描规则、安全常量 |
| `tests/` | Vitest |

PR 约定：改动保持小而聚焦；行为变更同步更新相关测试；在 PR 说明里写清「为什么」。

## 免责声明

任何自动化都无法保证 X 不会限流或限制账号。Follow Gate 只降低风险。请优先使用 Safe。切勿导出 cookies、headers 或 tokens。
```

- [ ] **Step 2: Structural mirror check**

Run:

```bash
rg -n "^#|^## " README.md README.zh-CN.md
```

Expected headings (same order, language-localized titles):

| EN | ZH |
|----|----|
| `# Follow Gate` | `# Follow Gate` |
| `## What it does` | `## 它做什么` |
| `## Features` | `## 特征` |
| `## Usage` | `## 如何使用` |
| `## Development` | `## 如何参与开发` |
| `## Disclaimer` | `## 免责声明` |

Both files must contain the language switcher line linking to each other.

- [ ] **Step 3: Number parity check**

Run:

```bash
rg -n "2–10|≤5|≤20|≤10|< 10|≥ 100|× 1\.2|statusesCount|friendsCount" README.md README.zh-CN.md
```

Expected: both files mention the same Safe caps and strategy thresholds.

- [ ] **Step 4: Commit Chinese README**

```bash
git add README.zh-CN.md
git commit -m "$(cat <<'EOF'
docs: add Chinese README mirror

Provide a full zh-CN edition aligned with the English structure
for purpose, features, usage, and development.
EOF
)"
```

---

### Task 4: Final acceptance checklist

**Files:**
- Verify: `README.md`, `README.zh-CN.md`

**Interfaces:**
- Consumes: deliverables from Tasks 2–3

- [ ] **Step 1: Spec coverage pass**

Confirm against `docs/superpowers/specs/2026-08-20-readme-design.md`:

- [ ] Purpose present in both languages
- [ ] Features cover local/permissions, multi-strategy, Safe limits, anti-abuse, reviewable cleanup
- [ ] Usage has install + main flow
- [ ] Development has scripts + layout + PR note
- [ ] Removed sections are gone
- [ ] No screenshots / no CONTRIBUTING.md added

- [ ] **Step 2: Two-minute reader test (manual)**

Read each README once and answer:

1. What is this?
2. Why is it cautious?
3. How do I install and run it?
4. How do I contribute?

All four answers must be obvious without opening source files.

- [ ] **Step 3: No further commit unless fixes were needed**

If Step 1–2 found wording bugs, fix both READMEs in the same commit:

```bash
git add README.md README.zh-CN.md
git commit -m "$(cat <<'EOF'
docs: fix README wording after acceptance check

Keep English and Chinese mirrors aligned after review fixes.
EOF
)"
```

Otherwise leave Task 2–3 commits as the final state.

---

## Spec coverage (self-review)

| Spec requirement | Task |
|------------------|------|
| EN + ZH dual docs with mutual links | Task 2, Task 3 |
| Purpose / Features / Usage / Development / Disclaimer | Task 2, Task 3 |
| Safe 2–10s and caps from code | Task 1 → Tasks 2–3 |
| Multi-strategy OR + thresholds + whitelist + null safety | Task 2, Task 3 |
| Trim permissions/recovery/out-of-scope/how-it-works | Task 2 Step 2, Task 4 |
| No screenshots / no CONTRIBUTING | Task 4 |
| Mirror maintenance (same inventory) | Task 3 Step 2–3 |
