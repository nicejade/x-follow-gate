export const manifest: chrome.runtime.ManifestV3 = {
  manifest_version: 3,
  name: "Follow Gate",
  version: "0.1.0",
  description: "本地分析 X 关注关系，并以保守队列清理未回关账号。",
  minimum_chrome_version: "114",
  permissions: ["storage", "alarms", "sidePanel", "tabs", "scripting"],
  host_permissions: ["https://x.com/*", "https://twitter.com/*"],
  background: {
    service_worker: "background.js",
    type: "module",
  },
  side_panel: {
    default_path: "sidepanel/index.html",
  },
  action: {
    default_title: "打开 Follow Gate",
  },
  content_scripts: [
    {
      matches: ["https://x.com/*", "https://twitter.com/*"],
      js: ["content-main-world.js"],
      run_at: "document_start",
      world: "MAIN",
    },
    {
      matches: ["https://x.com/*", "https://twitter.com/*"],
      js: ["content-isolated.js"],
      run_at: "document_start",
      world: "ISOLATED",
    },
  ],
};
