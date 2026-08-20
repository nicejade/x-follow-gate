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
