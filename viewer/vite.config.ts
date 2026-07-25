import { fileURLToPath } from "node:url";
import vinext from "vinext";
import { defineConfig, loadEnv } from "vite";
import hostingConfig from "./.openai/hosting.json";
import { localProgress } from "./build/local-progress-vite-plugin";
import { sites } from "./build/sites-vite-plugin";

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";
const CONFIG_DIRECTORY = fileURLToPath(new URL(".", import.meta.url));

const { d1, r2 } = hostingConfig;

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

const localBindingConfig = {
  main: "./worker/index.ts",
  compatibility_flags: ["nodejs_compat"],
  d1_databases: d1
    ? [
        {
          binding: d1,
          database_name: "site-creator-d1",
          database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
        },
      ]
    : [],
  r2_buckets: r2
    ? [
        {
          binding: r2,
          bucket_name: "site-creator-r2",
        },
      ]
    : [],
};

export default defineConfig(async ({ mode }) => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");
  const atlasEnvironment = loadEnv(
    mode,
    CONFIG_DIRECTORY,
    "OBSIDIAN_ATLAS_",
  );
  const progressFile = atlasEnvironment.OBSIDIAN_ATLAS_PROGRESS_FILE;
  const serverOptions = {
    ...(isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : {}),
    // Vinext enables Vite's console-forwarding client without its matching
    // transport in this multi-environment setup. One rejected promise then
    // recursively fills the error overlay; local Chrome already has DevTools.
    ...(progressFile ? { forwardConsole: false, strictPort: true } : {}),
  };

  return {
    server: Object.keys(serverOptions).length > 0 ? serverOptions : undefined,
    plugins: [
      localProgress({
        progressFile,
      }),
      vinext(),
      sites(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: localBindingConfig,
      }),
    ],
  };
});
