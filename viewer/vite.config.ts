import { fileURLToPath } from "node:url";
import vinext from "vinext";
import { defineConfig, loadEnv } from "vite";
import {
  resolveLocalAtlasDevelopmentPaths,
} from "./build/local-atlas-development";
import { localAtlas } from "./build/local-atlas-vite-plugin";

const CONFIG_DIRECTORY = fileURLToPath(new URL(".", import.meta.url));
const REPOSITORY_TILE_ROOT = fileURLToPath(
  new URL("../2b2t_tiles", import.meta.url),
);
const REPOSITORY_REGIONAL_TILE_ROOT = fileURLToPath(
  new URL("../2b2t_tiles_regions", import.meta.url),
);

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

const localBindingConfig = {
  main: "./worker/index.ts",
  compatibility_flags: ["nodejs_compat"],
};

export default defineConfig(async ({ command, mode }) => {
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
  const { tileRoot, regionalTileRoot, backingRoot } =
    resolveLocalAtlasDevelopmentPaths({
      command,
      configuredTileRoot:
        atlasEnvironment.OBSIDIAN_ATLAS_TILE_ROOT,
      configuredRegionalTileRoot:
        atlasEnvironment.OBSIDIAN_ATLAS_REGIONAL_TILE_ROOT,
      configuredBackingRoot:
        atlasEnvironment.OBSIDIAN_ATLAS_BACKING_ROOT,
      repositoryTileRoot: REPOSITORY_TILE_ROOT,
      repositoryRegionalTileRoot: REPOSITORY_REGIONAL_TILE_ROOT,
    });
  const pythonBin = atlasEnvironment.OBSIDIAN_ATLAS_PYTHON;
  const requirementText =
    atlasEnvironment.OBSIDIAN_ATLAS_OVERWORLD_REQUIREMENT_BYTES;
  const requirementBytes = requirementText
    ? Number(requirementText)
    : undefined;
  const serverOptions = {
    ...(isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : {}),
    // Vinext enables Vite's console-forwarding client without its matching
    // transport in this multi-environment setup. One rejected promise then
    // recursively fills the error overlay; local Chrome already has DevTools.
    ...(tileRoot ? { forwardConsole: false, strictPort: true } : {}),
  };

  return {
    server: Object.keys(serverOptions).length > 0 ? serverOptions : undefined,
    plugins: [
      localAtlas({
        tileRoot,
        regionalTileRoot,
        backingRoot,
        pythonBin,
        projectRoot: fileURLToPath(new URL("..", import.meta.url)),
        overworldRequirementBytes: requirementBytes,
      }),
      vinext(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: localBindingConfig,
        inspectorPort: isCodexSeatbeltSandbox ? false : undefined,
      }),
    ],
  };
});
