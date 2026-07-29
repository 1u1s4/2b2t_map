import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  LocalAtlasXaeroExporter,
  XaeroExportError,
  netherCoordinate,
  xaeroColorIndex,
  xaeroWaypointLine,
} from "../build/local-atlas-xaero.ts";
import {
  parseLocalAtlasXaeroPreview,
  parseLocalAtlasXaeroResult,
} from "../app/lib/local-atlas-runtime.ts";

const HEADER = [
  "#",
  "#waypoint:name:initials:x:y:z:color:disabled:type:set:rotate_on_tp:tp_yaw:visibility_type:destination",
  "#",
].join("\n");

function exploration(
  id = "region-test",
  bounds = {
    minX: -512,
    minZ: -512,
    maxXExclusive: 512,
    maxZExclusive: 512,
  },
) {
  return {
    id,
    createdAt: "2026-07-26T17:00:00.000Z",
    updatedAt: "2026-07-26T17:00:00.000Z",
    state: {
      version: 1,
      dimension: "overworld",
      region: { id, name: "Región prueba", bounds, lod: 0, scale: 1 },
      currentIndex: 0,
      currentCellPreviouslyReviewed: false,
      reviewedCount: 0,
      reviewedBits: "AA",
      skippedCount: 0,
      skippedBits: "AA",
    },
  };
}

function workspace(highlights, revision = 7, explorations = []) {
  return {
    schemaVersion: 1,
    workspaceId: "11111111-1111-4111-8111-111111111111",
    revision,
    updatedAt: "2026-07-26T18:00:00.000Z",
    lastWriteId: "22222222-2222-4222-8222-222222222222",
    activeExplorationId: explorations[0]?.id ?? null,
    explorations,
    highlights,
    coverageSelection: null,
  };
}

function pin(overrides = {}) {
  return {
    id: randomUUID(),
    type: "pin",
    title: "Punto: Norte",
    note: "",
    color: "#ff5f57",
    x: -9,
    z: 15,
    visible: true,
    createdAt: "2026-07-26T17:00:00.000Z",
    ...overrides,
  };
}

async function fixture({
  minecraftOpen = false,
  minecraftOpenProbe,
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "atlas-xaero-"));
  const minecraftRoot = join(root, "minecraft");
  const backingRoot = join(root, "LuisA");
  const serverRoot = join(
    minecraftRoot,
    "xaero",
    "minimap",
    "Multiplayer_2b2t.org",
  );
  const overworldPath = join(serverRoot, "dim%0", "mw$default_1.txt");
  const netherPath = join(serverRoot, "dim%-1", "mw$default_1.txt");
  await Promise.all([
    mkdir(join(serverRoot, "dim%0"), { recursive: true }),
    mkdir(join(serverRoot, "dim%-1"), { recursive: true }),
    mkdir(backingRoot, { recursive: true }),
  ]);
  const overworldExisting =
    "waypoint:Existing OW:EO:100:64:200:1:false:0:gui.xaero_default:false:0:0:false";
  const netherExisting =
    "waypoint:Existing N:EN:12:64:25:2:false:0:gui.xaero_default:false:0:0:false";
  await Promise.all([
    writeFile(overworldPath, `${HEADER}\n${overworldExisting}\n`),
    writeFile(netherPath, `${HEADER}\n${netherExisting}\n`),
  ]);
  const exporter = new LocalAtlasXaeroExporter({
    minecraftRoot,
    backingRoot,
    minecraftOpenProbe:
      minecraftOpenProbe ?? (async () => minecraftOpen),
    now: () => new Date("2026-07-26T19:00:00.000Z"),
  });
  return {
    root,
    backingRoot,
    minecraftRoot,
    exporter,
    overworldPath,
    netherPath,
    overworldExisting,
    netherExisting,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test("Xaero format adds the suffix once and floors Nether coordinates", () => {
  assert.equal(netherCoordinate(7), 0);
  assert.equal(netherCoordinate(8), 1);
  assert.equal(netherCoordinate(-1), -1);
  assert.equal(netherCoordinate(-8), -1);
  assert.equal(netherCoordinate(-9), -2);
  assert.equal(xaeroColorIndex("#ff5f57"), 12);
  assert.equal(xaeroColorIndex("#ffbd4a"), 6);
  assert.equal(xaeroColorIndex("#26d9c7"), 3);
  assert.equal(xaeroColorIndex("#62a8ff"), 17);
  assert.equal(xaeroColorIndex("#c58cff"), 13);

  const highlight = pin({ title: "Punto: Norte - Atlas", visible: false });
  const overworld = xaeroWaypointLine(highlight, "overworld");
  const nether = xaeroWaypointLine(highlight, "nether");
  assert.match(overworld, /^waypoint:Punto§§ Norte - Atlas:/);
  assert.doesNotMatch(overworld, /Atlas - Atlas/);
  assert.match(overworld, /:-9:~:15:12:true:0:gui\.xaero_default:/);
  assert.match(nether, /:-2:~:1:12:true:0:gui\.xaero_default:/);
  assert.equal(overworld.split(":").length, 14);
  assert.equal(nether.split(":").length, 14);
  assert.throws(
    () => xaeroWaypointLine(pin({ title: "Token §§ literal" }), "overworld"),
    /token reservado/,
  );
});

test("browser parser accepts only canonical dual-dimension previews", () => {
  const value = {
    version: 1,
    previewId: "a".repeat(64),
    workspaceId: "11111111-1111-4111-8111-111111111111",
    workspaceRevision: 7,
    operation: "export",
    scope: "all",
    explorationId: null,
    regionName: null,
    minecraftOpen: false,
    canExport: true,
    hasChanges: true,
    sourceHighlights: 1,
    selectedHighlights: 1,
    managedHighlights: 0,
    removableHighlights: 0,
    exportableHighlights: 1,
    skippedAreas: 0,
    notesNotExported: 0,
    duplicateNames: 0,
    conflicts: 0,
    overworld: {
      existing: 10,
      added: 1,
      updated: 0,
      unchanged: 0,
      removed: 0,
      alreadyAbsent: 0,
      conflicts: 0,
      final: 11,
    },
    nether: {
      existing: 5,
      added: 1,
      updated: 0,
      unchanged: 0,
      removed: 0,
      alreadyAbsent: 0,
      conflicts: 0,
      final: 6,
    },
  };
  assert.deepEqual(parseLocalAtlasXaeroPreview(value), value);
  assert.equal(
    parseLocalAtlasXaeroPreview({
      ...value,
      nether: { ...value.nether, final: 7 },
    }),
    null,
  );
  assert.equal(
    parseLocalAtlasXaeroPreview({ ...value, canExport: true, minecraftOpen: true }),
    null,
  );
  assert.ok(
    parseLocalAtlasXaeroResult({
      ...value,
      canExport: false,
      hasChanges: false,
      committed: true,
      exportedAt: "2026-07-26T19:00:00.000Z",
      backupId:
        "2026-07-26T19-00-00.000Z-33333333-3333-4333-8333-333333333333",
    }),
  );
});

test("dual export preserves existing rows, backs up, and is idempotent", async () => {
  const setup = await fixture();
  try {
    const highlight = pin();
    const source = workspace([highlight]);
    const preview = await setup.exporter.preview(source);
    assert.equal(preview.minecraftOpen, false);
    assert.equal(preview.canExport, true);
    assert.equal(preview.exportableHighlights, 1);
    assert.deepEqual(preview.overworld, {
      existing: 1,
      added: 1,
      updated: 0,
      unchanged: 0,
      removed: 0,
      alreadyAbsent: 0,
      conflicts: 0,
      final: 2,
    });
    assert.deepEqual(preview.nether, {
      existing: 1,
      added: 1,
      updated: 0,
      unchanged: 0,
      removed: 0,
      alreadyAbsent: 0,
      conflicts: 0,
      final: 2,
    });

    const commitWriteId = randomUUID();
    const result = await setup.exporter.commit(
      source,
      preview.previewId,
      commitWriteId,
    );
    assert.equal(result.committed, true);
    assert.deepEqual(
      await setup.exporter.commit(
        source,
        preview.previewId,
        commitWriteId,
      ),
      result,
    );
    const [overworld, nether] = await Promise.all([
      readFile(setup.overworldPath, "utf8"),
      readFile(setup.netherPath, "utf8"),
    ]);
    assert.match(overworld, new RegExp(setup.overworldExisting));
    assert.match(nether, new RegExp(setup.netherExisting));
    assert.match(
      overworld,
      /waypoint:Punto§§ Norte - Atlas:PN:-9:~:15:12:false:0:gui\.xaero_default:false:0:0:false/,
    );
    assert.match(
      nether,
      /waypoint:Punto§§ Norte - Atlas:PN:-2:~:1:12:false:0:gui\.xaero_default:false:0:0:false/,
    );

    const manifest = JSON.parse(
      await readFile(
        join(
          setup.backingRoot,
          "ObsidianAtlas",
          "state",
          "xaero-export-manifest.v1.json",
        ),
        "utf8",
      ),
    );
    assert.equal(manifest.entries.length, 1);
    assert.equal(manifest.entries[0].highlightId, highlight.id);
    assert.ok(manifest.entries[0].overworld.lineHash);
    assert.ok(manifest.entries[0].nether.lineHash);

    const backupRoot = join(
      setup.backingRoot,
      "ObsidianAtlas",
      "backups",
      "xaero",
    );
    const backups = await readdir(backupRoot);
    assert.equal(backups.length, 1);
    const backupFiles = await readdir(join(backupRoot, backups[0]));
    assert.deepEqual(
      backupFiles.sort(),
      ["metadata.json", "nether.before.txt", "overworld.before.txt"].sort(),
    );

    const after = await setup.exporter.preview(source);
    assert.equal(after.hasChanges, false);
    assert.equal(after.canExport, false);
    assert.equal(after.overworld.added, 0);
    assert.equal(after.overworld.unchanged, 1);
    assert.equal(after.nether.added, 0);
    assert.equal(after.nether.unchanged, 1);
    await assert.rejects(
      setup.exporter.commit(source, after.previewId, randomUUID()),
      (error) =>
        error instanceof XaeroExportError &&
        error.code === "XAERO_NO_CHANGES",
    );
  } finally {
    await setup.cleanup();
  }
});

test("Minecraft open allows preview but blocks every write", async () => {
  const setup = await fixture({ minecraftOpen: true });
  try {
    const source = workspace([pin()]);
    const before = await Promise.all([
      readFile(setup.overworldPath),
      readFile(setup.netherPath),
    ]);
    const preview = await setup.exporter.preview(source);
    assert.equal(preview.minecraftOpen, true);
    assert.equal(preview.canExport, false);
    await assert.rejects(
      setup.exporter.commit(source, preview.previewId, randomUUID()),
      (error) =>
        error instanceof XaeroExportError &&
        error.code === "XAERO_MINECRAFT_OPEN",
    );
    const after = await Promise.all([
      readFile(setup.overworldPath),
      readFile(setup.netherPath),
    ]);
    assert.deepEqual(after, before);
  } finally {
    await setup.cleanup();
  }
});

test("Minecraft opening mid-export defers rollback until it closes", async () => {
  let simulateOpening = true;
  let probes = 0;
  const setup = await fixture({
    minecraftOpenProbe: async () => {
      probes += 1;
      return simulateOpening && probes >= 4;
    },
  });
  try {
    const source = workspace([pin()]);
    const before = await Promise.all([
      readFile(setup.overworldPath),
      readFile(setup.netherPath),
    ]);
    const preview = await setup.exporter.preview(source);
    assert.equal(probes, 1);

    await assert.rejects(
      setup.exporter.commit(source, preview.previewId, randomUUID()),
      (error) =>
        error instanceof XaeroExportError &&
        error.code === "XAERO_MINECRAFT_OPEN",
    );
    assert.notDeepEqual(await readFile(setup.overworldPath), before[0]);
    assert.deepEqual(await readFile(setup.netherPath), before[1]);
    await readFile(
      join(
        setup.backingRoot,
        "ObsidianAtlas",
        "state",
        ".xaero-export-transaction.v1.json",
      ),
    );

    simulateOpening = false;
    const recovered = await setup.exporter.preview(source);
    assert.equal(recovered.canExport, true);
    assert.deepEqual(await readFile(setup.overworldPath), before[0]);
    assert.deepEqual(await readFile(setup.netherPath), before[1]);
    await assert.rejects(
      readFile(
        join(
          setup.backingRoot,
          "ObsidianAtlas",
          "state",
          ".xaero-export-transaction.v1.json",
        ),
      ),
      (error) => error?.code === "ENOENT",
    );
  } finally {
    await setup.cleanup();
  }
});

test("Minecraft opening mid-remove restores both dimensions from its journal", async () => {
  let simulateOpening = false;
  let probes = 0;
  const setup = await fixture({
    minecraftOpenProbe: async () => {
      probes += 1;
      return simulateOpening && probes >= 4;
    },
  });
  try {
    const source = workspace([pin()]);
    const exportPreview = await setup.exporter.preview(source);
    await setup.exporter.commit(
      source,
      exportPreview.previewId,
      randomUUID(),
    );
    const beforeRemove = await Promise.all([
      readFile(setup.overworldPath),
      readFile(setup.netherPath),
    ]);

    probes = 0;
    simulateOpening = true;
    const selection = { operation: "remove", scope: "all" };
    const removePreview = await setup.exporter.preview(
      source,
      selection,
    );
    assert.equal(probes, 1);
    await assert.rejects(
      setup.exporter.commit(
        source,
        removePreview.previewId,
        randomUUID(),
        selection,
      ),
      (error) =>
        error instanceof XaeroExportError &&
        error.code === "XAERO_MINECRAFT_OPEN",
    );
    assert.notDeepEqual(
      await readFile(setup.overworldPath),
      beforeRemove[0],
    );
    assert.deepEqual(
      await readFile(setup.netherPath),
      beforeRemove[1],
    );
    await readFile(
      join(
        setup.backingRoot,
        "ObsidianAtlas",
        "state",
        ".xaero-export-transaction.v1.json",
      ),
    );

    simulateOpening = false;
    const recovered = await setup.exporter.preview(source, selection);
    assert.equal(recovered.hasChanges, true);
    assert.deepEqual(
      await readFile(setup.overworldPath),
      beforeRemove[0],
    );
    assert.deepEqual(
      await readFile(setup.netherPath),
      beforeRemove[1],
    );
    await assert.rejects(
      readFile(
        join(
          setup.backingRoot,
          "ObsidianAtlas",
          "state",
          ".xaero-export-transaction.v1.json",
        ),
      ),
      (error) => error?.code === "ENOENT",
    );
  } finally {
    await setup.cleanup();
  }
});

test("Minecraft opening after Nether is installed leaves recovery journal intact", async () => {
  let simulateOpening = true;
  let probes = 0;
  const setup = await fixture({
    minecraftOpenProbe: async () => {
      probes += 1;
      return simulateOpening && probes >= 6;
    },
  });
  try {
    const source = workspace([pin()]);
    const before = await Promise.all([
      readFile(setup.overworldPath),
      readFile(setup.netherPath),
    ]);
    const preview = await setup.exporter.preview(source);
    assert.equal(probes, 1);

    await assert.rejects(
      setup.exporter.commit(source, preview.previewId, randomUUID()),
      (error) =>
        error instanceof XaeroExportError &&
        error.code === "XAERO_MINECRAFT_OPEN",
    );
    assert.notDeepEqual(await readFile(setup.overworldPath), before[0]);
    assert.notDeepEqual(await readFile(setup.netherPath), before[1]);
    await readFile(
      join(
        setup.backingRoot,
        "ObsidianAtlas",
        "state",
        ".xaero-export-transaction.v1.json",
      ),
    );
    await assert.rejects(
      readFile(
        join(
          setup.backingRoot,
          "ObsidianAtlas",
          "state",
          "xaero-export-manifest.v1.json",
        ),
      ),
      (error) => error?.code === "ENOENT",
    );

    simulateOpening = false;
    const recovered = await setup.exporter.preview(source);
    assert.equal(recovered.canExport, true);
    assert.deepEqual(await readFile(setup.overworldPath), before[0]);
    assert.deepEqual(await readFile(setup.netherPath), before[1]);
    await assert.rejects(
      readFile(
        join(
          setup.backingRoot,
          "ObsidianAtlas",
          "state",
          ".xaero-export-transaction.v1.json",
        ),
      ),
      (error) => error?.code === "ENOENT",
    );
  } finally {
    await setup.cleanup();
  }
});

for (const scenario of [
  {
    name: "after the manifest is installed",
    openAtProbe: 8,
  },
  {
    name: "before the recovery journal is removed",
    openAtProbe: 9,
  },
]) {
  test(`Minecraft opening ${scenario.name} preserves the committed pair`, async () => {
    let simulateOpening = true;
    let probes = 0;
    const setup = await fixture({
      minecraftOpenProbe: async () => {
        probes += 1;
        return simulateOpening && probes >= scenario.openAtProbe;
      },
    });
    try {
      const source = workspace([pin()]);
      const before = await Promise.all([
        readFile(setup.overworldPath),
        readFile(setup.netherPath),
      ]);
      const preview = await setup.exporter.preview(source);

      await assert.rejects(
        setup.exporter.commit(source, preview.previewId, randomUUID()),
        (error) =>
          error instanceof XaeroExportError &&
          error.code === "XAERO_MINECRAFT_OPEN",
      );
      const installed = await Promise.all([
        readFile(setup.overworldPath),
        readFile(setup.netherPath),
      ]);
      assert.notDeepEqual(installed[0], before[0]);
      assert.notDeepEqual(installed[1], before[1]);
      await readFile(
        join(
          setup.backingRoot,
          "ObsidianAtlas",
          "state",
          "xaero-export-manifest.v1.json",
        ),
      );
      await readFile(
        join(
          setup.backingRoot,
          "ObsidianAtlas",
          "state",
          ".xaero-export-transaction.v1.json",
        ),
      );

      simulateOpening = false;
      const recovered = await setup.exporter.preview(source);
      assert.equal(recovered.hasChanges, false);
      assert.deepEqual(await readFile(setup.overworldPath), installed[0]);
      assert.deepEqual(await readFile(setup.netherPath), installed[1]);
      await assert.rejects(
        readFile(
          join(
            setup.backingRoot,
            "ObsidianAtlas",
            "state",
            ".xaero-export-transaction.v1.json",
          ),
        ),
        (error) => error?.code === "ENOENT",
      );
    } finally {
      await setup.cleanup();
    }
  });
}

test("a live exporter lock blocks a second Atlas process", async () => {
  let releaseProbe;
  let announceProbe;
  const probeEntered = new Promise((resolve) => {
    announceProbe = resolve;
  });
  const probeGate = new Promise((resolve) => {
    releaseProbe = resolve;
  });
  const setup = await fixture({
    minecraftOpenProbe: async () => {
      announceProbe();
      await probeGate;
      return false;
    },
  });
  try {
    const source = workspace([pin()]);
    const firstPreview = setup.exporter.preview(source);
    await probeEntered;
    const secondExporter = new LocalAtlasXaeroExporter({
      minecraftRoot: setup.minecraftRoot,
      backingRoot: setup.backingRoot,
      minecraftOpenProbe: async () => false,
    });
    await assert.rejects(
      secondExporter.preview(source),
      (error) =>
        error instanceof XaeroExportError &&
        error.code === "XAERO_LOCKED",
    );
    releaseProbe();
    assert.equal((await firstPreview).hasChanges, true);
  } finally {
    releaseProbe?.();
    await setup.cleanup();
  }
});

test("an external edit before the first rename stays intact and clears the journal", async () => {
  let probes = 0;
  let overworldPath;
  const externalLine =
    "waypoint:External:EX:55:64:89:4:false:0:gui.xaero_default:false:0:0:false";
  const setup = await fixture({
    minecraftOpenProbe: async () => {
      probes += 1;
      if (probes === 3) {
        await writeFile(
          overworldPath,
          `${await readFile(overworldPath, "utf8")}${externalLine}\n`,
        );
      }
      return false;
    },
  });
  overworldPath = setup.overworldPath;
  try {
    const source = workspace([pin()]);
    const preview = await setup.exporter.preview(source);
    await assert.rejects(
      setup.exporter.commit(source, preview.previewId, randomUUID()),
      (error) =>
        error instanceof XaeroExportError &&
        error.code === "XAERO_STALE_PREVIEW",
    );
    assert.match(await readFile(setup.overworldPath, "utf8"), /External:EX/);
    assert.doesNotMatch(
      await readFile(setup.netherPath, "utf8"),
      /Punto§§ Norte - Atlas/,
    );
    await assert.rejects(
      readFile(
        join(
          setup.backingRoot,
          "ObsidianAtlas",
          "state",
          ".xaero-export-transaction.v1.json",
        ),
      ),
      (error) => error?.code === "ENOENT",
    );
    assert.equal((await setup.exporter.preview(source)).canExport, true);
  } finally {
    await setup.cleanup();
  }
});

test("manual edits become conflicts and are never overwritten", async () => {
  const setup = await fixture();
  try {
    const highlight = pin();
    const initialWorkspace = workspace([highlight]);
    const first = await setup.exporter.preview(initialWorkspace);
    await setup.exporter.commit(
      initialWorkspace,
      first.previewId,
      randomUUID(),
    );

    const exportedLine = xaeroWaypointLine(highlight, "overworld");
    const manuallyEdited = (await readFile(setup.overworldPath, "utf8")).replace(
      exportedLine,
      exportedLine.replace("Punto§§ Norte", "Editado manualmente"),
    );
    await writeFile(setup.overworldPath, manuallyEdited);

    const changedWorkspace = workspace(
      [{ ...highlight, title: "Nuevo nombre" }],
      8,
    );
    const preview = await setup.exporter.preview(changedWorkspace);
    assert.equal(preview.conflicts, 1);
    assert.equal(preview.exportableHighlights, 0);
    assert.equal(preview.hasChanges, false);
    assert.match(
      await readFile(setup.overworldPath, "utf8"),
      /Editado manualmente/,
    );
  } finally {
    await setup.cleanup();
  }
});

test("deleted highlights retain ownership until an explicit safe removal", async () => {
  const setup = await fixture();
  try {
    const highlight = pin();
    const initial = workspace([highlight]);
    const preview = await setup.exporter.preview(initial);
    await setup.exporter.commit(
      initial,
      preview.previewId,
      randomUUID(),
    );
    const exportedOverworld = xaeroWaypointLine(highlight, "overworld");
    const exportedNether = xaeroWaypointLine(highlight, "nether");

    const withoutHighlight = workspace([], 8);
    const detachPreview = await setup.exporter.preview(withoutHighlight);
    assert.equal(detachPreview.hasChanges, false);
    assert.match(
      await readFile(setup.overworldPath, "utf8"),
      new RegExp(exportedOverworld.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
    assert.match(
      await readFile(setup.netherPath, "utf8"),
      new RegExp(exportedNether.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
    const manifest = JSON.parse(
      await readFile(
        join(
          setup.backingRoot,
          "ObsidianAtlas",
          "state",
          "xaero-export-manifest.v1.json",
        ),
        "utf8",
      ),
    );
    assert.equal(manifest.entries.length, 1);

    const removePreview = await setup.exporter.preview(withoutHighlight, {
      operation: "remove",
      scope: "all",
    });
    assert.equal(removePreview.selectedHighlights, 0);
    assert.equal(removePreview.managedHighlights, 1);
    assert.equal(removePreview.removableHighlights, 1);
    assert.equal(removePreview.overworld.removed, 1);
    assert.equal(removePreview.nether.removed, 1);
    await setup.exporter.commit(
      withoutHighlight,
      removePreview.previewId,
      randomUUID(),
      { operation: "remove", scope: "all" },
    );
    assert.doesNotMatch(
      await readFile(setup.overworldPath, "utf8"),
      new RegExp(exportedOverworld.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
    assert.doesNotMatch(
      await readFile(setup.netherPath, "utf8"),
      new RegExp(exportedNether.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
    const removedManifest = JSON.parse(
      await readFile(
        join(
          setup.backingRoot,
          "ObsidianAtlas",
          "state",
          "xaero-export-manifest.v1.json",
        ),
        "utf8",
      ),
    );
    assert.deepEqual(removedManifest.entries, []);

    const reintroduced = await setup.exporter.preview(
      workspace([highlight], 9),
    );
    assert.equal(reintroduced.conflicts, 0);
    assert.equal(reintroduced.hasChanges, true);
  } finally {
    await setup.cleanup();
  }
});

test("regional removal uses stored half-open Overworld coordinates", async () => {
  const setup = await fixture();
  try {
    const region = exploration("region-negative", {
      minX: -512,
      minZ: -512,
      maxXExclusive: 0,
      maxZExclusive: 0,
    });
    const atMinimum = pin({
      id: "pin-minimum",
      title: "Mínimo",
      x: -512,
      z: -512,
    });
    const negativeInterior = pin({
      id: "pin-negative",
      title: "Interior",
      x: -1,
      z: -1,
    });
    const atExclusiveX = pin({
      id: "pin-max-x",
      title: "Máximo X",
      x: 0,
      z: -1,
    });
    const atExclusiveZ = pin({
      id: "pin-max-z",
      title: "Máximo Z",
      x: -1,
      z: 0,
    });
    const initial = workspace(
      [atMinimum, negativeInterior, atExclusiveX, atExclusiveZ],
      7,
      [region],
    );
    const allPreview = await setup.exporter.preview(initial);
    await setup.exporter.commit(
      initial,
      allPreview.previewId,
      randomUUID(),
    );

    const movedAndDeleted = workspace(
      [
        { ...negativeInterior, x: 100, z: 100 },
        atExclusiveX,
        atExclusiveZ,
      ],
      8,
      [region],
    );
    const selection = {
      operation: "remove",
      scope: "exploration",
      explorationId: region.id,
    };
    const preview = await setup.exporter.preview(
      movedAndDeleted,
      selection,
    );
    assert.equal(preview.regionName, "Región prueba");
    assert.equal(preview.selectedHighlights, 0);
    assert.equal(preview.managedHighlights, 2);
    assert.equal(preview.removableHighlights, 2);
    assert.equal(preview.overworld.removed, 2);
    assert.equal(preview.nether.removed, 2);
    await setup.exporter.commit(
      movedAndDeleted,
      preview.previewId,
      randomUUID(),
      selection,
    );

    const [overworld, nether, manifest] = await Promise.all([
      readFile(setup.overworldPath, "utf8"),
      readFile(setup.netherPath, "utf8"),
      readFile(
        join(
          setup.backingRoot,
          "ObsidianAtlas",
          "state",
          "xaero-export-manifest.v1.json",
        ),
        "utf8",
      ).then(JSON.parse),
    ]);
    for (const highlight of [atMinimum, negativeInterior]) {
      assert.doesNotMatch(
        overworld,
        new RegExp(
          xaeroWaypointLine(highlight, "overworld").replace(
            /[.*+?^${}()|[\]\\]/g,
            "\\$&",
          ),
        ),
      );
      assert.doesNotMatch(
        nether,
        new RegExp(
          xaeroWaypointLine(highlight, "nether").replace(
            /[.*+?^${}()|[\]\\]/g,
            "\\$&",
          ),
        ),
      );
    }
    for (const highlight of [atExclusiveX, atExclusiveZ]) {
      assert.match(
        overworld,
        new RegExp(
          xaeroWaypointLine(highlight, "overworld").replace(
            /[.*+?^${}()|[\]\\]/g,
            "\\$&",
          ),
        ),
      );
    }
    assert.deepEqual(
      manifest.entries.map((entry) => entry.highlightId).sort(),
      [atExclusiveX.id, atExclusiveZ.id].sort(),
    );
  } finally {
    await setup.cleanup();
  }
});

test("remove preserves duplicated rows and recognizes an already absent target", async () => {
  const setup = await fixture();
  try {
    const highlight = pin();
    const source = workspace([highlight]);
    const exportPreview = await setup.exporter.preview(source);
    await setup.exporter.commit(
      source,
      exportPreview.previewId,
      randomUUID(),
    );
    const exportedOverworld = xaeroWaypointLine(highlight, "overworld");
    const exportedNether = xaeroWaypointLine(highlight, "nether");
    const foreignAtlas =
      "waypoint:Manual - Atlas:MA:777:~:888:4:false:0:gui.xaero_default:false:0:0:false";
    await Promise.all([
      writeFile(
        setup.overworldPath,
        `${await readFile(setup.overworldPath, "utf8")}${exportedOverworld}\n${foreignAtlas}\n`,
      ),
      writeFile(
        setup.netherPath,
        `${await readFile(setup.netherPath, "utf8")}${foreignAtlas}\n`,
      ),
    ]);

    const selection = { operation: "remove", scope: "all" };
    const conflict = await setup.exporter.preview(source, selection);
    assert.equal(conflict.conflicts, 1);
    assert.equal(conflict.overworld.conflicts, 1);
    assert.equal(conflict.nether.unchanged, 1);
    assert.equal(conflict.overworld.removed, 0);
    assert.equal(conflict.nether.removed, 0);
    assert.equal(conflict.hasChanges, false);

    await Promise.all([
      writeFile(
        setup.overworldPath,
        (await readFile(setup.overworldPath, "utf8")).replace(
          `${exportedOverworld}\n`,
          "",
        ),
      ),
      writeFile(
        setup.netherPath,
        (await readFile(setup.netherPath, "utf8")).replace(
          `${exportedNether}\n`,
          "",
        ),
      ),
    ]);
    const safe = await setup.exporter.preview(source, selection);
    assert.equal(safe.overworld.removed, 1);
    assert.equal(safe.nether.alreadyAbsent, 1);
    assert.equal(safe.removableHighlights, 1);
    await setup.exporter.commit(
      source,
      safe.previewId,
      randomUUID(),
      selection,
    );
    assert.match(
      await readFile(setup.overworldPath, "utf8"),
      new RegExp(
        foreignAtlas.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      ),
    );
    assert.match(
      await readFile(setup.netherPath, "utf8"),
      new RegExp(
        foreignAtlas.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      ),
    );
  } finally {
    await setup.cleanup();
  }
});
