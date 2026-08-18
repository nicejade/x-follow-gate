import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { build, defineConfig, type Plugin } from "vite";

import { manifest } from "./src/manifest.ts";

const rootDir = fileURLToPath(new URL(".", import.meta.url));
const srcDir = fileURLToPath(new URL("./src", import.meta.url));
const outDir = fileURLToPath(new URL("./dist", import.meta.url));
const extensionIconPath = `${rootDir}/x.png`;

/**
 * Content scripts are injected as classic scripts, so each one must be a
 * single self-contained file without ESM import statements or shared chunks.
 */
const contentScriptEntries = {
  "content-isolated": `${srcDir}/content/isolated.ts`,
  "content-main-world": `${srcDir}/content/main-world.ts`,
} as const;

function emitManifest(): Plugin {
  return {
    name: "follow-gate:emit-manifest",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "manifest.json",
        source: `${JSON.stringify(manifest, null, 2)}\n`,
      });
      this.emitFile({
        type: "asset",
        fileName: "x.png",
        source: readFileSync(extensionIconPath),
      });
    },
  };
}

function buildContentScripts(mode: string): Plugin {
  return {
    name: "follow-gate:build-content-scripts",
    apply: "build",
    async closeBundle() {
      for (const [name, entry] of Object.entries(contentScriptEntries)) {
        await build({
          configFile: false,
          mode,
          resolve: { alias: { "@": srcDir } },
          build: {
            outDir,
            emptyOutDir: false,
            target: "chrome114",
            sourcemap: mode === "development",
            lib: {
              entry,
              formats: ["iife"],
              name: "followGate",
              fileName: () => `${name}.js`,
            },
          },
        });
      }
    },
  };
}

export default defineConfig(({ mode }) => ({
  root: srcDir,
  base: "./",
  publicDir: false,
  plugins: [react(), tailwindcss(), emitManifest(), buildContentScripts(mode)],
  resolve: {
    alias: { "@": srcDir },
  },
  build: {
    outDir,
    emptyOutDir: true,
    target: "chrome114",
    sourcemap: mode === "development",
    rollupOptions: {
      input: {
        background: `${srcDir}/background/index.ts`,
        sidepanel: `${srcDir}/sidepanel/index.html`,
      },
      output: {
        // The manifest points at a flat `background.js`; the side panel entry is
        // loaded through its HTML file, so it can stay hashed under `assets/`.
        entryFileNames: (chunk) =>
          chunk.name === "background" ? "background.js" : "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
}));
