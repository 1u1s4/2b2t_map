import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveLocalAtlasDevelopmentPaths } from "../build/local-atlas-development.ts";

test("development auto-discovers the repository tile library", async (t) => {
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "obsidian-atlas-development-"),
  );
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const repositoryTileRoot = join(temporaryRoot, "2b2t_tiles");
  const repositoryRegionalTileRoot = join(
    temporaryRoot,
    "2b2t_tiles_regions",
  );
  await mkdir(repositoryTileRoot);

  assert.deepEqual(
    resolveLocalAtlasDevelopmentPaths({
      command: "serve",
      repositoryTileRoot,
      repositoryRegionalTileRoot,
    }),
    {
      tileRoot: repositoryTileRoot,
      regionalTileRoot: repositoryRegionalTileRoot,
      backingRoot: repositoryTileRoot,
    },
  );
});

test("explicit local paths override repository auto-discovery", async (t) => {
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "obsidian-atlas-development-"),
  );
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const repositoryTileRoot = join(temporaryRoot, "2b2t_tiles");
  const repositoryRegionalTileRoot = join(
    temporaryRoot,
    "2b2t_tiles_regions",
  );
  await mkdir(repositoryTileRoot);

  assert.deepEqual(
    resolveLocalAtlasDevelopmentPaths({
      command: "serve",
      configuredTileRoot: " /tiles/external ",
      configuredRegionalTileRoot: " /tiles/regions ",
      configuredBackingRoot: " /Volumes/LuisA ",
      repositoryTileRoot,
      repositoryRegionalTileRoot,
    }),
    {
      tileRoot: "/tiles/external",
      regionalTileRoot: "/tiles/regions",
      backingRoot: "/Volumes/LuisA",
    },
  );
});

test("an explicit primary root derives an isolated regional root", () => {
  assert.deepEqual(
    resolveLocalAtlasDevelopmentPaths({
      command: "serve",
      configuredTileRoot: " /tiles/external ",
      repositoryTileRoot: "/unused/2b2t_tiles",
      repositoryRegionalTileRoot: "/unused/2b2t_tiles_regions",
    }),
    {
      tileRoot: "/tiles/external",
      regionalTileRoot: "/tiles/external_regions",
      backingRoot: undefined,
    },
  );
});

test("production builds never capture the ignored local library", async (t) => {
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "obsidian-atlas-development-"),
  );
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const repositoryTileRoot = join(temporaryRoot, "2b2t_tiles");
  const repositoryRegionalTileRoot = join(
    temporaryRoot,
    "2b2t_tiles_regions",
  );
  await mkdir(repositoryTileRoot);

  assert.deepEqual(
    resolveLocalAtlasDevelopmentPaths({
      command: "build",
      repositoryTileRoot,
      repositoryRegionalTileRoot,
    }),
    {
      tileRoot: undefined,
      regionalTileRoot: undefined,
      backingRoot: undefined,
    },
  );
});
