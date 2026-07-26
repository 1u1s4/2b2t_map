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
  await mkdir(repositoryTileRoot);

  assert.deepEqual(
    resolveLocalAtlasDevelopmentPaths({
      command: "serve",
      repositoryTileRoot,
    }),
    {
      tileRoot: repositoryTileRoot,
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
  await mkdir(repositoryTileRoot);

  assert.deepEqual(
    resolveLocalAtlasDevelopmentPaths({
      command: "serve",
      configuredTileRoot: " /tiles/external ",
      configuredBackingRoot: " /Volumes/LuisA ",
      repositoryTileRoot,
    }),
    {
      tileRoot: "/tiles/external",
      backingRoot: "/Volumes/LuisA",
    },
  );
});

test("production builds never capture the ignored local library", async (t) => {
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "obsidian-atlas-development-"),
  );
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const repositoryTileRoot = join(temporaryRoot, "2b2t_tiles");
  await mkdir(repositoryTileRoot);

  assert.deepEqual(
    resolveLocalAtlasDevelopmentPaths({
      command: "build",
      repositoryTileRoot,
    }),
    {
      tileRoot: undefined,
      backingRoot: undefined,
    },
  );
});
