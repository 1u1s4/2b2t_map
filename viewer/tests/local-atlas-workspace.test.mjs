import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AtlasWorkspaceError,
  LocalAtlasWorkspaceStore,
  atlasWorkspaceEtag,
  parseAtlasWorkspaceContent,
  parseAtlasWorkspaceDocument,
  parseAtlasWorkspaceEtag,
} from "../build/local-atlas-workspace.ts";
import {
  createExplorationState,
  deserializeExplorationState,
  serializeExplorationState,
  withCellReviewed,
  withCellSkipped,
  withCurrentIndex,
} from "../app/lib/exploration-grid.ts";
import { createCoverageSelection } from "../app/lib/overworld-coverage.ts";
import {
  localAtlasWorkspaceContent,
  parseLocalAtlasWorkspace,
  parseLocalAtlasWorkspaceContent,
  parseLocalAtlasWorkspaceExplorations,
} from "../app/lib/local-atlas-runtime.ts";
import {
  consolidateSingleWorkspaceContent,
  consolidateWorkspaceExplorations,
  mergeMatchingWorkspaceProgress,
} from "../app/lib/single-workspace-session.ts";

const NOW = "2026-07-25T12:00:00.000Z";

function explorationState(id = "region-a") {
  let state = createExplorationState({
    id,
    name: "Región persistida",
    bounds: {
      minX: -1024,
      minZ: 0,
      maxXExclusive: 1024,
      maxZExclusive: 1024,
    },
    lod: 0,
    scale: 1,
  });
  state = withCurrentIndex(state, 3);
  state = withCellReviewed(state, 0);
  state = withCellReviewed(state, 3);
  state = withCellSkipped(state, 1);
  return JSON.parse(serializeExplorationState(state));
}

function content(overrides = {}) {
  const state = explorationState();
  return {
    schemaVersion: 1,
    activeExplorationId: state.region.id,
    explorations: [
      {
        id: state.region.id,
        createdAt: NOW,
        updatedAt: NOW,
        state,
      },
    ],
    highlights: [
      {
        id: "highlight-a",
        type: "area",
        title: "Base",
        note: "Entrada norte",
        color: "#FF5F57",
        regionKey: "-1024:0:1024:1024",
        x: -512,
        z: 256,
        bounds: {
          x1: -700,
          z1: 100,
          x2: -300,
          z2: 500,
        },
        visible: true,
        createdAt: NOW,
      },
    ],
    coverageSelection: createCoverageSelection(10, 10, 12, 13),
    ...overrides,
  };
}

function contentForExploration(id, overrides = {}) {
  const state = explorationState(id);
  return content({
    activeExplorationId: id,
    explorations: [
      {
        id,
        createdAt: NOW,
        updatedAt: NOW,
        state,
      },
    ],
    ...overrides,
  });
}

async function withTemporaryBacking(operation) {
  const backingRoot = await mkdtemp(join(tmpdir(), "atlas-workspace-"));
  try {
    return await operation(backingRoot);
  } finally {
    await rm(backingRoot, { recursive: true, force: true });
  }
}

async function assertNoWorkspaceTransientFiles(store) {
  const names = await readdir(store.stateDirectory);
  assert.deepEqual(
    names.filter(
      (name) =>
        name.endsWith(".tmp") ||
        name.includes(".lock") ||
        name.includes(".stale."),
    ),
    [],
  );
}

test("workspace parser canonicalizes nested state, coverage, and highlights", () => {
  const parsed = parseAtlasWorkspaceContent(content());
  assert.equal(parsed.explorations.length, 1);
  assert.equal(parsed.explorations[0].state.reviewedCount, 2);
  assert.equal(parsed.explorations[0].state.skippedCount, 1);
  assert.equal(parsed.highlights[0].color, "#ff5f57");
  assert.equal(parsed.highlights[0].regionKey, "-1024:0:1024:1024");
  assert.equal(parsed.coverageSelection?.cellCount, 6);

  assert.throws(
    () =>
      parseAtlasWorkspaceContent({
        ...content(),
        activeExplorationId: "missing",
      }),
    /exploración activa no existe/,
  );
  assert.throws(
    () =>
      parseAtlasWorkspaceContent({
        ...content(),
        highlights: [
          content().highlights[0],
          content().highlights[0],
        ],
      }),
    /ids de highlight duplicados/,
  );
  assert.throws(
    () =>
      parseAtlasWorkspaceContent({
        ...content(),
        highlights: [
          {
            ...content().highlights[0],
            regionKey: "region-id-inestable",
          },
        ],
      }),
    /región del highlight no es válida/,
  );
  const tampered = content();
  tampered.explorations[0].state.reviewedCount = 99;
  assert.throws(
    () => parseAtlasWorkspaceContent(tampered),
    /sesión de exploración no es válida/,
  );
});

test("workspace v1 accepts legacy highlights without a region scope", () => {
  const legacy = content();
  delete legacy.highlights[0].regionKey;

  const diskParsed = parseAtlasWorkspaceContent(legacy);
  const clientParsed = parseLocalAtlasWorkspaceContent(legacy);

  assert.equal("regionKey" in diskParsed.highlights[0], false);
  assert.equal("regionKey" in clientParsed.highlights[0], false);
});

test("single-session consolidation preserves the richest overlapping review progress", () => {
  let target = createExplorationState({
    id: "region-target",
    name: "Sector principal",
    bounds: {
      minX: 0,
      minZ: 0,
      maxXExclusive: 2048,
      maxZExclusive: 1024,
    },
    lod: 0,
    scale: 1,
  });
  target = withCellReviewed(target, 0);
  target = withCellReviewed(target, 1);
  target = withCellReviewed(target, 2);

  let overlap = createExplorationState({
    id: "region-overlap",
    name: "Recorte legado",
    bounds: {
      minX: 1024,
      minZ: 512,
      maxXExclusive: 2048,
      maxZExclusive: 1024,
    },
    lod: 0,
    scale: 1,
  });
  overlap = withCellReviewed(overlap, 0);
  overlap = withCellSkipped(overlap, 1);

  const records = [
    {
      id: target.region.id,
      createdAt: "2026-07-25T10:00:00.000Z",
      updatedAt: "2026-07-25T11:00:00.000Z",
      state: JSON.parse(serializeExplorationState(target)),
    },
    {
      id: overlap.region.id,
      createdAt: "2026-07-25T12:00:00.000Z",
      updatedAt: "2026-07-25T13:00:00.000Z",
      state: JSON.parse(serializeExplorationState(overlap)),
    },
  ];
  const consolidated = consolidateWorkspaceExplorations(
    records,
    overlap.region.id,
  );
  assert.ok(consolidated);
  assert.equal(consolidated.id, target.region.id);
  const restored = deserializeExplorationState(
    JSON.stringify(consolidated.state),
  );
  assert.equal(restored.reviewedCount, 4);
  assert.equal(restored.skippedCount, 0);

  const singleton = consolidateSingleWorkspaceContent({
    schemaVersion: 1,
    activeExplorationId: overlap.region.id,
    explorations: records,
    highlights: [{ id: "highlight-preserved" }],
    coverageSelection: null,
  });
  assert.equal(singleton.activeExplorationId, target.region.id);
  assert.equal(singleton.explorations.length, 1);
  assert.deepEqual(singleton.highlights, [{ id: "highlight-preserved" }]);
  assert.deepEqual(
    consolidateSingleWorkspaceContent(singleton),
    singleton,
  );
  assert.equal(
    consolidateSingleWorkspaceContent({
      ...singleton,
      activeExplorationId: null,
    }).activeExplorationId,
    null,
  );
});

test("a stale journal merges only progress for the same spatial region", () => {
  const current = contentForExploration("region-current");
  let recoveredState = createExplorationState({
    id: "region-recovery",
    name: "Copia inmediata",
    bounds: current.explorations[0].state.region.bounds,
    lod: 0,
    scale: 1,
  });
  recoveredState = withCellReviewed(recoveredState, 2);
  recoveredState = withCellReviewed(recoveredState, 4);
  const recovery = contentForExploration("region-recovery", {
    explorations: [
      {
        id: "region-recovery",
        createdAt: NOW,
        updatedAt: "2026-07-25T12:01:00.000Z",
        state: JSON.parse(serializeExplorationState(recoveredState)),
      },
    ],
    highlights: [],
    coverageSelection: null,
  });

  const merged = mergeMatchingWorkspaceProgress(current, recovery);

  assert.ok(merged);
  assert.equal(merged.activeExplorationId, "region-current");
  assert.equal(merged.explorations[0].id, "region-current");
  assert.equal(
    deserializeExplorationState(
      JSON.stringify(merged.explorations[0].state),
    ).reviewedCount,
    4,
  );
  assert.deepEqual(merged.highlights, current.highlights);
  assert.deepEqual(merged.coverageSelection, current.coverageSelection);

  const adjacent = contentForExploration("region-adjacent", {
    explorations: [
      {
        ...recovery.explorations[0],
        id: "region-adjacent",
        state: {
          ...recovery.explorations[0].state,
          region: {
            ...recovery.explorations[0].state.region,
            id: "region-adjacent",
            bounds: {
              ...recovery.explorations[0].state.region.bounds,
              minX:
                recovery.explorations[0].state.region.bounds
                  .maxXExclusive,
              maxXExclusive:
                recovery.explorations[0].state.region.bounds
                  .maxXExclusive + 2048,
            },
          },
        },
      },
    ],
  });
  assert.equal(mergeMatchingWorkspaceProgress(current, adjacent), null);
});

test("workspace ETags are strong, canonical, and bounded", () => {
  const workspaceId = randomUUID();
  const etag = `"atlas-${workspaceId}-42"`;
  assert.equal(atlasWorkspaceEtag(workspaceId, 42), etag);
  assert.deepEqual(parseAtlasWorkspaceEtag(etag), {
    workspaceId,
    revision: 42,
  });
  for (const invalid of [
    undefined,
    "atlas-42",
    'W/"atlas-42"',
    '"atlas-42"',
    '"atlas-01"',
    '"atlas--1"',
  ]) {
    assert.equal(parseAtlasWorkspaceEtag(invalid), null);
  }
});

test("browser parser projects a canonical disk workspace back to writable content", () => {
  const parsedContent = parseAtlasWorkspaceContent(content());
  const document = {
    ...parsedContent,
    workspaceId: randomUUID(),
    revision: 7,
    updatedAt: NOW,
    lastWriteId: randomUUID(),
  };
  const browserWorkspace = parseLocalAtlasWorkspace(document);
  assert.ok(browserWorkspace);
  assert.equal(browserWorkspace.revision, 7);
  assert.deepEqual(
    localAtlasWorkspaceContent(browserWorkspace),
    parsedContent,
  );

  const tampered = structuredClone(document);
  tampered.explorations[0].state.reviewedCount = 999;
  assert.equal(parseLocalAtlasWorkspace(tampered), null);
});

test("browser recovery cache accepts only canonical saved explorations", () => {
  assert.deepEqual(
    parseLocalAtlasWorkspaceContent(content()),
    parseAtlasWorkspaceContent(content()),
  );
  const explorations = content().explorations;
  assert.deepEqual(
    parseLocalAtlasWorkspaceExplorations(explorations),
    explorations,
  );
  assert.equal(
    parseLocalAtlasWorkspaceExplorations([
      explorations[0],
      explorations[0],
    ]),
    null,
  );
  const tampered = structuredClone(explorations);
  tampered[0].state.reviewedCount = 999;
  assert.equal(parseLocalAtlasWorkspaceExplorations(tampered), null);
  assert.equal(
    parseLocalAtlasWorkspaceContent({
      ...content(),
      activeExplorationId: "missing",
    }),
    null,
  );
});

test("legacy multi-session write archives the source and commits one canonical session", async () => {
  await withTemporaryBacking(async (backingRoot) => {
    const store = new LocalAtlasWorkspaceStore(backingRoot);
    await store.read();
    const firstState = explorationState("region-a");
    const secondState = explorationState("region-b");
    const legacyContent = parseAtlasWorkspaceContent(
      content({
        activeExplorationId: "region-b",
        explorations: [
          {
            id: "region-a",
            createdAt: "2026-07-25T10:00:00.000Z",
            updatedAt: "2026-07-25T11:00:00.000Z",
            state: firstState,
          },
          {
            id: "region-b",
            createdAt: "2026-07-25T12:00:00.000Z",
            updatedAt: "2026-07-25T13:00:00.000Z",
            state: secondState,
          },
        ],
      }),
    );
    const workspaceId = randomUUID();
    const legacyDocument = {
      ...legacyContent,
      workspaceId,
      revision: 57,
      updatedAt: NOW,
      lastWriteId: randomUUID(),
    };
    await writeFile(
      store.workspacePath,
      `${JSON.stringify(legacyDocument)}\n`,
    );

    const saved = await store.write(
      legacyContent,
      { workspaceId, revision: 57 },
      randomUUID(),
    );
    assert.equal(saved.workspace.revision, 58);
    assert.equal(saved.workspace.explorations.length, 1);
    assert.equal(saved.workspace.activeExplorationId, "region-b");

    const archiveNames = (
      await readdir(store.migrationBackupDirectory)
    ).filter((name) => name.startsWith("single-session-"));
    assert.equal(archiveNames.length, 1);
    const archiveDirectory = join(
      store.migrationBackupDirectory,
      archiveNames[0],
    );
    const manifest = JSON.parse(
      await readFile(join(archiveDirectory, "manifest.json"), "utf8"),
    );
    assert.equal(manifest.currentSessionCount, 2);
    assert.equal(manifest.candidateSessionCount, 2);
    assert.equal(manifest.selectedSessionId, "region-b");
    assert.equal(
      JSON.parse(
        await readFile(
          join(archiveDirectory, "workspace-candidate.json"),
          "utf8",
        ),
      ).explorations.length,
      2,
    );

    const reread = await store.read();
    assert.equal(reread.workspace.revision, 58);
    assert.equal(
      (
        await readdir(store.migrationBackupDirectory)
      ).filter((name) => name.startsWith("single-session-")).length,
      1,
    );
  });
});

test("replacing the canonical session archives the previous workspace", async () => {
  await withTemporaryBacking(async (backingRoot) => {
    const store = new LocalAtlasWorkspaceStore(backingRoot);
    const empty = await store.read();
    const first = await store.write(
      contentForExploration("region-a"),
      empty.workspace,
      randomUUID(),
    );
    const replacementWriteId = randomUUID();
    const candidate = contentForExploration("region-b");

    const replaced = await store.write(
      candidate,
      first.workspace,
      replacementWriteId,
    );

    assert.equal(replaced.workspace.activeExplorationId, "region-b");
    const archiveNames = await readdir(store.replacementBackupDirectory);
    assert.equal(archiveNames.length, 1);
    const archiveDirectory = join(
      store.replacementBackupDirectory,
      archiveNames[0],
    );
    const before = JSON.parse(
      await readFile(
        join(archiveDirectory, "workspace-before.json"),
        "utf8",
      ),
    );
    const archivedCandidate = JSON.parse(
      await readFile(
        join(archiveDirectory, "workspace-candidate.json"),
        "utf8",
      ),
    );
    const manifest = JSON.parse(
      await readFile(join(archiveDirectory, "manifest.json"), "utf8"),
    );
    assert.equal(before.activeExplorationId, "region-a");
    assert.equal(archivedCandidate.activeExplorationId, "region-b");
    assert.equal(manifest.reason, "single-session-replacement");
    assert.equal(manifest.currentSessionId, "region-a");
    assert.equal(manifest.candidateSessionId, "region-b");
    assert.equal(manifest.writeId, replacementWriteId);
  });
});

test("the store rejects a poorer replacement for the same spatial region", async () => {
  await withTemporaryBacking(async (backingRoot) => {
    const store = new LocalAtlasWorkspaceStore(backingRoot);
    const empty = await store.read();
    const first = await store.write(
      contentForExploration("region-rich"),
      empty.workspace,
      randomUUID(),
    );
    let poorerState = createExplorationState({
      id: "region-poor",
      name: "Región reiniciada",
      bounds: first.workspace.explorations[0].state.region.bounds,
      lod: 0,
      scale: 1,
    });
    poorerState = withCellReviewed(poorerState, 0);
    const poorerSerialized = JSON.parse(
      serializeExplorationState(poorerState),
    );
    const candidate = contentForExploration("region-poor", {
      explorations: [
        {
          id: "region-poor",
          createdAt: NOW,
          updatedAt: NOW,
          state: poorerSerialized,
        },
      ],
    });

    await assert.rejects(
      store.write(candidate, first.workspace, randomUUID()),
      (error) =>
        error instanceof AtlasWorkspaceError &&
        error.code === "WORKSPACE_CONFLICT" &&
        error.current?.revision === first.workspace.revision,
    );

    let disjointState = createExplorationState({
      id: "region-disjoint",
      name: "Región con conteo equivalente",
      bounds: first.workspace.explorations[0].state.region.bounds,
      lod: 0,
      scale: 1,
    });
    disjointState = withCellReviewed(disjointState, 2);
    disjointState = withCellReviewed(disjointState, 4);
    const disjointCandidate = contentForExploration(
      "region-disjoint",
      {
        explorations: [
          {
            id: "region-disjoint",
            createdAt: NOW,
            updatedAt: NOW,
            state: JSON.parse(
              serializeExplorationState(disjointState),
            ),
          },
        ],
      },
    );
    await assert.rejects(
      store.write(disjointCandidate, first.workspace, randomUUID()),
      (error) =>
        error instanceof AtlasWorkspaceError &&
        error.code === "WORKSPACE_CONFLICT",
    );

    const reread = await store.read();
    assert.equal(reread.workspace.activeExplorationId, "region-rich");
    assert.equal(
      reread.workspace.explorations[0].state.reviewedCount,
      first.workspace.explorations[0].state.reviewedCount,
    );
    await assert.rejects(
      readdir(store.replacementBackupDirectory),
      (error) => error.code === "ENOENT",
    );
  });
});

test("updating the same canonical session does not create a replacement archive", async () => {
  await withTemporaryBacking(async (backingRoot) => {
    const store = new LocalAtlasWorkspaceStore(backingRoot);
    const empty = await store.read();
    const first = await store.write(
      contentForExploration("region-a"),
      empty.workspace,
      randomUUID(),
    );

    await store.write(
      contentForExploration("region-a", { highlights: [] }),
      first.workspace,
      randomUUID(),
    );

    await assert.rejects(
      readdir(store.replacementBackupDirectory),
      (error) => error.code === "ENOENT",
    );
  });
});

test("an idempotent replacement retry does not duplicate its archive", async () => {
  await withTemporaryBacking(async (backingRoot) => {
    const store = new LocalAtlasWorkspaceStore(backingRoot);
    const empty = await store.read();
    const first = await store.write(
      contentForExploration("region-a"),
      empty.workspace,
      randomUUID(),
    );
    const candidate = contentForExploration("region-b");
    const replacementWriteId = randomUUID();
    const replaced = await store.write(
      candidate,
      first.workspace,
      replacementWriteId,
    );

    const retried = await store.write(
      candidate,
      first.workspace,
      replacementWriteId,
    );

    assert.deepEqual(retried.workspace, replaced.workspace);
    assert.equal(
      (await readdir(store.replacementBackupDirectory)).length,
      1,
    );
  });
});

test("store writes atomically, keeps a previous backup, and is idempotent", async () => {
  await withTemporaryBacking(async (backingRoot) => {
    const store = new LocalAtlasWorkspaceStore(backingRoot);
    const empty = await store.read();
    assert.equal(empty.workspace.revision, 0);
    assert.equal(empty.workspace.explorations.length, 0);
    assert.equal(
      store.workspacePath,
      join(
        backingRoot,
        "ObsidianAtlas",
        "state",
        "atlas-workspace.v1.json",
      ),
    );

    const firstWriteId = randomUUID();
    const first = await store.write(content(), empty.workspace, firstWriteId);
    assert.equal(first.workspace.revision, 1);
    assert.equal(first.workspace.lastWriteId, firstWriteId);
    assert.equal(
      parseAtlasWorkspaceDocument(
        JSON.parse(await readFile(store.backupPath, "utf8")),
      ).revision,
      1,
    );

    const retried = await store.write(
      content(),
      empty.workspace,
      firstWriteId,
    );
    assert.deepEqual(retried.workspace, first.workspace);
    await assert.rejects(
      store.write(
        content({ highlights: [] }),
        first.workspace,
        firstWriteId,
      ),
      (error) =>
        error instanceof AtlasWorkspaceError &&
        error.code === "WORKSPACE_CONFLICT" &&
        /otro contenido/.test(error.message),
    );
    await assert.rejects(
      store.write(
        content(),
        { workspaceId: randomUUID(), revision: first.workspace.revision },
        randomUUID(),
      ),
      (error) =>
        error instanceof AtlasWorkspaceError &&
        error.code === "WORKSPACE_CONFLICT",
    );

    const secondContent = content({
      highlights: [
        {
          ...content().highlights[0],
          title: "Base actualizada",
        },
      ],
    });
    const second = await store.write(
      secondContent,
      first.workspace,
      randomUUID(),
    );
    assert.equal(second.workspace.revision, 2);
    assert.equal(second.workspace.highlights[0].title, "Base actualizada");

    const persisted = parseAtlasWorkspaceDocument(
      JSON.parse(await readFile(store.workspacePath, "utf8")),
    );
    const backup = parseAtlasWorkspaceDocument(
      JSON.parse(await readFile(store.backupPath, "utf8")),
    );
    assert.equal(persisted.revision, 2);
    assert.equal(backup.revision, 1);
  });
});

test("two store instances serialize writers and enforce revision CAS", async () => {
  await withTemporaryBacking(async (backingRoot) => {
    const firstStore = new LocalAtlasWorkspaceStore(backingRoot);
    const secondStore = new LocalAtlasWorkspaceStore(backingRoot);
    const empty = await firstStore.read();
    const seeded = await firstStore.write(
      content(),
      empty.workspace,
      randomUUID(),
    );
    const updated = content({
      highlights: [
        {
          ...content().highlights[0],
          title: "Actualización concurrente",
        },
      ],
    });
    const writes = await Promise.allSettled([
      firstStore.write(updated, seeded.workspace, randomUUID()),
      secondStore.write(updated, seeded.workspace, randomUUID()),
    ]);
    const fulfilled = writes.filter((result) => result.status === "fulfilled");
    const rejected = writes.filter((result) => result.status === "rejected");
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.equal(
      rejected[0].reason instanceof AtlasWorkspaceError,
      true,
    );
    assert.equal(rejected[0].reason.code, "WORKSPACE_CONFLICT");
    assert.equal(rejected[0].reason.current.revision, 2);

    const final = await firstStore.read();
    assert.equal(final.workspace.revision, 2);
    assert.equal(final.workspace.explorations.length, 1);
    await assertNoWorkspaceTransientFiles(firstStore);
  });
});

test("store restores a corrupt primary from the last valid backup", async () => {
  await withTemporaryBacking(async (backingRoot) => {
    const store = new LocalAtlasWorkspaceStore(backingRoot);
    const empty = await store.read();
    const first = await store.write(content(), empty.workspace, randomUUID());
    const second = await store.write(content(), first.workspace, randomUUID());
    await writeFile(store.workspacePath, "{truncated", "utf8");

    const recovered = await store.read();
    assert.equal(recovered.recoveredFromBackup, true);
    assert.equal(recovered.workspace.revision, 1);
    assert.notEqual(recovered.workspace.workspaceId, second.workspace.workspaceId);
    const restored = parseAtlasWorkspaceDocument(
      JSON.parse(await readFile(store.workspacePath, "utf8")),
    );
    assert.equal(restored.revision, 1);
    assert.equal(restored.workspaceId, recovered.workspace.workspaceId);
  });
});

test("backup recovery changes lineage so a rolled-back ETag cannot pass CAS", async () => {
  await withTemporaryBacking(async (backingRoot) => {
    const store = new LocalAtlasWorkspaceStore(backingRoot);
    const empty = await store.read();
    const first = await store.write(content(), empty.workspace, randomUUID());
    const oldRevisionTwo = await store.write(
      content({ highlights: [] }),
      first.workspace,
      randomUUID(),
    );
    await writeFile(store.workspacePath, "{truncated", "utf8");

    const recovered = await store.read();
    const newRevisionTwo = await store.write(
      content(),
      recovered.workspace,
      randomUUID(),
    );
    assert.equal(oldRevisionTwo.workspace.revision, 2);
    assert.equal(newRevisionTwo.workspace.revision, 2);
    assert.notEqual(
      oldRevisionTwo.workspace.workspaceId,
      newRevisionTwo.workspace.workspaceId,
    );
    await assert.rejects(
      store.write(content(), oldRevisionTwo.workspace, randomUUID()),
      (error) =>
        error instanceof AtlasWorkspaceError &&
        error.code === "WORKSPACE_CONFLICT" &&
        error.current.workspaceId === newRevisionTwo.workspace.workspaceId,
    );
  });
});

test("store refuses writes when both primary and backup are corrupt", async () => {
  await withTemporaryBacking(async (backingRoot) => {
    const store = new LocalAtlasWorkspaceStore(backingRoot);
    const empty = await store.read();
    const first = await store.write(content(), empty.workspace, randomUUID());
    await store.write(content(), first.workspace, randomUUID());
    await writeFile(store.workspacePath, "{broken", "utf8");
    await writeFile(store.backupPath, "{also-broken", "utf8");

    await assert.rejects(
      store.read(),
      (error) =>
        error instanceof AtlasWorkspaceError &&
        error.code === "WORKSPACE_CORRUPT",
    );
  });
});

test("store rejects a symlinked state directory", async () => {
  await withTemporaryBacking(async (backingRoot) => {
    const outside = await mkdtemp(join(tmpdir(), "atlas-outside-"));
    try {
      await symlink(outside, join(backingRoot, "ObsidianAtlas"));
      const store = new LocalAtlasWorkspaceStore(backingRoot);
      await assert.rejects(
        store.read(),
        (error) =>
          error instanceof AtlasWorkspaceError &&
          error.code === "UNSAFE_WORKSPACE_PATH",
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("store rejects a symlinked workspace file", async () => {
  await withTemporaryBacking(async (backingRoot) => {
    const outside = await mkdtemp(join(tmpdir(), "atlas-outside-file-"));
    try {
      const store = new LocalAtlasWorkspaceStore(backingRoot);
      await store.read();
      const outsideWorkspace = join(outside, "workspace.json");
      await writeFile(outsideWorkspace, JSON.stringify(content()), "utf8");
      await symlink(outsideWorkspace, store.workspacePath);

      await assert.rejects(
        store.read(),
        (error) =>
          error instanceof AtlasWorkspaceError &&
          error.code === "UNSAFE_WORKSPACE_PATH",
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("store retires an old lock whose owner process no longer exists", async () => {
  await withTemporaryBacking(async (backingRoot) => {
    const store = new LocalAtlasWorkspaceStore(backingRoot);
    await store.read();
    await writeFile(
      store.lockPath,
      JSON.stringify({
        pid: 2_147_483_647,
        nonce: randomUUID(),
        createdAt: NOW,
      }),
      "utf8",
    );
    const oldDate = new Date(Date.now() - 120_000);
    await utimes(store.lockPath, oldDate, oldDate);

    const secondStore = new LocalAtlasWorkspaceStore(backingRoot);
    const results = await Promise.all([store.read(), secondStore.read()]);
    assert.equal(results[0].workspace.revision, 0);
    assert.equal(results[1].workspace.revision, 0);
  });
});

test("store recovers an orphaned stale lock reaper", async () => {
  await withTemporaryBacking(async (backingRoot) => {
    const store = new LocalAtlasWorkspaceStore(backingRoot);
    await store.read();
    await writeFile(
      store.lockPath,
      JSON.stringify({
        pid: 2_147_483_647,
        nonce: randomUUID(),
        createdAt: NOW,
      }),
      "utf8",
    );
    await writeFile(
      store.lockReaperPath,
      JSON.stringify({
        pid: 2_147_483_647,
        nonce: randomUUID(),
        createdAt: NOW,
      }),
      "utf8",
    );
    const oldDate = new Date(Date.now() - 120_000);
    await utimes(store.lockPath, oldDate, oldDate);
    await utimes(store.lockReaperPath, oldDate, oldDate);

    const recovered = await store.read();
    assert.equal(recovered.workspace.revision, 0);
    await assertNoWorkspaceTransientFiles(store);
  });
});

test("store never retires a stale-looking reaper owned by a live process", async () => {
  await withTemporaryBacking(async (backingRoot) => {
    const store = new LocalAtlasWorkspaceStore(backingRoot);
    await store.read();
    await writeFile(
      store.lockPath,
      JSON.stringify({
        pid: 2_147_483_647,
        nonce: randomUUID(),
        createdAt: NOW,
      }),
      "utf8",
    );
    const liveNonce = randomUUID();
    await writeFile(
      store.lockReaperPath,
      JSON.stringify({
        pid: process.pid,
        nonce: liveNonce,
        createdAt: NOW,
      }),
      "utf8",
    );
    const oldDate = new Date(Date.now() - 120_000);
    await utimes(store.lockPath, oldDate, oldDate);
    await utimes(store.lockReaperPath, oldDate, oldDate);

    assert.equal(await store.removeStaleLock(), false);
    assert.equal(
      JSON.parse(await readFile(store.lockReaperPath, "utf8")).nonce,
      liveNonce,
    );
  });
});

test("store recovers its own lock after a transient unlink failure", async () => {
  await withTemporaryBacking(async (backingRoot) => {
    const store = new LocalAtlasWorkspaceStore(backingRoot);
    await store.read();
    const lock = await store.acquireFileLock();
    await chmod(store.stateDirectory, 0o500);
    try {
      await store.releaseFileLock(lock);
    } finally {
      await chmod(store.stateDirectory, 0o700);
    }
    const recovered = await store.read();
    assert.equal(recovered.workspace.revision, 0);
    await assertNoWorkspaceTransientFiles(store);
  });
});

test("store sweeps workspace temporaries abandoned by a crashed writer", async () => {
  await withTemporaryBacking(async (backingRoot) => {
    const store = new LocalAtlasWorkspaceStore(backingRoot);
    await store.read();
    await writeFile(
      join(
        store.stateDirectory,
        `.atlas-workspace.v1.json.999999.${randomUUID()}.tmp`,
      ),
      "partial workspace",
      "utf8",
    );

    await store.read();
    await assertNoWorkspaceTransientFiles(store);
  });
});

test("store rejects revision overflow before writing either durable file", async () => {
  await withTemporaryBacking(async (backingRoot) => {
    const store = new LocalAtlasWorkspaceStore(backingRoot);
    const empty = await store.read();
    const maximum = {
      ...parseAtlasWorkspaceContent(content()),
      workspaceId: empty.workspace.workspaceId,
      revision: Number.MAX_SAFE_INTEGER,
      updatedAt: NOW,
      lastWriteId: randomUUID(),
    };
    const serialized = `${JSON.stringify(maximum)}\n`;
    await writeFile(store.workspacePath, serialized, "utf8");
    await writeFile(store.backupPath, serialized, "utf8");

    await assert.rejects(
      store.write(content(), maximum, randomUUID()),
      (error) =>
        error instanceof AtlasWorkspaceError &&
        error.code === "WORKSPACE_UNAVAILABLE" &&
        /rango seguro/.test(error.message),
    );
    assert.equal(await readFile(store.workspacePath, "utf8"), serialized);
    assert.equal(await readFile(store.backupPath, "utf8"), serialized);
  });
});
