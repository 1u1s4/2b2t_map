import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { isObservedLod3TileAvailable } from "../app/lib/overworld-coverage-data.ts";
import { parseLocalAtlasCoverage } from "../app/lib/local-atlas-runtime.ts";
import { summarizeLocalCoverage } from "../app/lib/overworld-progress.ts";
import { createLocalAtlasMiddleware } from "../build/local-atlas-vite-plugin.ts";

const CREATE_COVERAGE_FIXTURE = String.raw`
import json
import sqlite3
import sys

database_path = sys.argv[1]
rows = json.loads(sys.argv[2])
connection = sqlite3.connect(database_path)
connection.execute(
    """
    CREATE TABLE tiles (
      id INTEGER PRIMARY KEY,
      dimension TEXT NOT NULL,
      layer TEXT NOT NULL,
      lod INTEGER NOT NULL,
      tile_x INTEGER NOT NULL,
      tile_z INTEGER NOT NULL,
      status TEXT NOT NULL
    )
    """
)
connection.executemany(
    """
    INSERT INTO tiles(dimension, layer, lod, tile_x, tile_z, status)
    VALUES ('overworld', 'base', ?, ?, ?, ?)
    """,
    rows,
)
connection.commit()
connection.close()
`;

async function withCoverageServer(rows, operation) {
  const tileRoot = await mkdtemp(join(tmpdir(), "atlas-coverage-http-"));
  execFileSync(
    "python3",
    [
      "-c",
      CREATE_COVERAGE_FIXTURE,
      join(tileRoot, "tiles.sqlite3"),
      JSON.stringify(rows),
    ],
    { stdio: "pipe" },
  );
  const runtime = createLocalAtlasMiddleware({
    tileRoot,
    pythonBin: "python3",
  });
  const server = createServer((request, response) => {
    void runtime.middleware(request, response, () => {
      response.statusCode = 404;
      response.end();
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    return await operation(baseUrl);
  } finally {
    runtime.close();
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await rm(tileRoot, { recursive: true, force: true });
  }
}

async function withCombinedCoverageServer(
  primaryRows,
  regionalRows,
  operation,
) {
  const root = await mkdtemp(join(tmpdir(), "atlas-combined-coverage-"));
  const primaryRoot = join(root, "primary");
  const regionalRoot = join(root, "regional");
  await mkdir(primaryRoot, { recursive: true });
  await mkdir(regionalRoot, { recursive: true });
  for (const [catalogRoot, rows] of [
    [primaryRoot, primaryRows],
    [regionalRoot, regionalRows],
  ]) {
    execFileSync(
      "python3",
      [
        "-c",
        CREATE_COVERAGE_FIXTURE,
        join(catalogRoot, "tiles.sqlite3"),
        JSON.stringify(rows),
      ],
      { stdio: "pipe" },
    );
  }
  const runtime = createLocalAtlasMiddleware({
    tileRoot: primaryRoot,
    regionalTileRoot: regionalRoot,
    pythonBin: "python3",
  });
  const server = createServer((request, response) => {
    void runtime.middleware(request, response, () => {
      response.statusCode = 404;
      response.end();
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    return await operation(`http://127.0.0.1:${address.port}`);
  } finally {
    runtime.close();
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await rm(root, { recursive: true, force: true });
  }
}

test("coverage combines catalogs once per tile with regional precedence", async () => {
  const published = [];
  for (let tileZ = -132; tileZ < -124; tileZ += 1) {
    for (let tileX = -132; tileX < -124; tileX += 1) {
      if (isObservedLod3TileAvailable(tileX, tileZ)) {
        published.push([tileX, tileZ]);
      }
    }
  }
  const [overridden, primaryOnly, regionalOnly] = published;
  await withCombinedCoverageServer(
    [
      [3, ...overridden, "complete"],
      [3, ...primaryOnly, "complete"],
    ],
    [
      [3, ...overridden, "pending"],
      [3, ...regionalOnly, "complete"],
    ],
    async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/local-atlas/coverage?layer=base&lod=3`,
      );
      assert.equal(response.status, 200);
      const snapshot = parseLocalAtlasCoverage(await response.json());
      assert.ok(snapshot);
      assert.deepEqual(snapshot.cells, [
        {
          row: 0,
          column: 0,
          completeCount: 2,
          queuedCount: 1,
          failedCount: 0,
          absentCount: 0,
        },
      ]);
    },
  );
});

test("coverage endpoint filters unpublished gaps and treats unknown failures conservatively", async () => {
  const published = [];
  const gaps = [];
  for (let tileZ = -132; tileZ < -124; tileZ += 1) {
    for (let tileX = -132; tileX < -124; tileX += 1) {
      const target = isObservedLod3TileAvailable(tileX, tileZ);
      (target ? published : gaps).push([tileX, tileZ]);
    }
  }
  assert.equal(published.length, 48);
  assert.equal(gaps.length, 16);

  const rows = [
    ...published
      .slice(0, 32)
      .map(([tileX, tileZ]) => [3, tileX, tileZ, "complete"]),
    ...gaps.map(([tileX, tileZ]) => [3, tileX, tileZ, "complete"]),
    [3, ...published[32], "pending"],
    [3, ...published[33], "corrupt"],
    [3, ...published[34], "protection"],
    [3, ...published[35], "future-unknown-status"],
    [3, ...published[36], "absent"],
    // At LOD 0, (-1040, -1052) descends from published LOD-3 tile
    // (-130, -132); (-1056, -1056) descends from an unpublished gap.
    [0, -1056, -1056, "complete"],
  ];
  const lod2Descendants = published.flatMap(([tileX, tileZ]) => [
    [tileX * 2, tileZ * 2],
    [tileX * 2 + 1, tileZ * 2],
    [tileX * 2, tileZ * 2 + 1],
    [tileX * 2 + 1, tileZ * 2 + 1],
  ]);
  const availableLod2 = new Set(["-260,-263", "-259,-263"]);
  rows.push(
    ...lod2Descendants.map(([tileX, tileZ]) => [
      2,
      tileX,
      tileZ,
      availableLod2.has(`${tileX},${tileZ}`)
        ? "complete"
        : "absent",
    ]),
  );
  const availableLod2Coordinates = lod2Descendants.filter(([tileX, tileZ]) =>
    availableLod2.has(`${tileX},${tileZ}`),
  );
  const lod1Descendants = availableLod2Coordinates.flatMap(
    ([tileX, tileZ]) => [
      [tileX * 2, tileZ * 2],
      [tileX * 2 + 1, tileZ * 2],
      [tileX * 2, tileZ * 2 + 1],
      [tileX * 2 + 1, tileZ * 2 + 1],
    ],
  );
  const availableLod1 = new Set(
    lod1Descendants
      .slice(0, 2)
      .map(([tileX, tileZ]) => `${tileX},${tileZ}`),
  );
  rows.push(
    ...lod1Descendants.map(([tileX, tileZ]) => [
      1,
      tileX,
      tileZ,
      availableLod1.has(`${tileX},${tileZ}`)
        ? "complete"
        : "absent",
    ]),
  );
  const availableLod1Coordinates = lod1Descendants.filter(([tileX, tileZ]) =>
    availableLod1.has(`${tileX},${tileZ}`),
  );
  const lod0Descendants = availableLod1Coordinates.flatMap(
    ([tileX, tileZ]) => [
      [tileX * 2, tileZ * 2],
      [tileX * 2 + 1, tileZ * 2],
      [tileX * 2, tileZ * 2 + 1],
      [tileX * 2 + 1, tileZ * 2 + 1],
    ],
  );
  const availableLod0 = new Set(
    lod0Descendants
      .slice(0, 3)
      .map(([tileX, tileZ]) => `${tileX},${tileZ}`),
  );
  rows.push(
    ...lod0Descendants.map(([tileX, tileZ]) => [
      0,
      tileX,
      tileZ,
      availableLod0.has(`${tileX},${tileZ}`)
        ? "complete"
        : "absent",
    ]),
  );

  await withCoverageServer(rows, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/local-atlas/coverage?layer=base&lod=3`,
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const raw = await response.json();
    const snapshot = parseLocalAtlasCoverage(raw);
    assert.ok(snapshot);
    assert.equal(snapshot.cells.length, 1);
    assert.deepEqual(snapshot.cells[0], {
      row: 0,
      column: 0,
      completeCount: 32,
      queuedCount: 1,
      failedCount: 3,
      absentCount: 1,
    });

    const progress = summarizeLocalCoverage(snapshot, 3);
    assert.ok(progress);
    assert.equal(progress.sectors[0].expectedCount, 48);
    assert.equal(progress.sectors[0].completeCount, 32);
    assert.equal(progress.sectors[0].queuedCount, 1);
    assert.equal(progress.sectors[0].failedCount, 3);
    assert.equal(progress.sectors[0].status, "in-progress");
    assert.equal(progress.queuedCount, 1);
    assert.equal(progress.failedCount, 3);

    const lod2Response = await fetch(
      `${baseUrl}/api/local-atlas/coverage?layer=base&lod=2`,
    );
    assert.equal(lod2Response.status, 200);
    const lod2Snapshot = parseLocalAtlasCoverage(
      await lod2Response.json(),
    );
    assert.ok(lod2Snapshot);
    assert.deepEqual(lod2Snapshot.cells[0], {
      row: 0,
      column: 0,
      completeCount: 2,
      queuedCount: 0,
      failedCount: 0,
      absentCount: 190,
    });
    const lod2Progress = summarizeLocalCoverage(lod2Snapshot, 2);
    assert.ok(lod2Progress);
    assert.equal(lod2Progress.sectors[0].expectedCount, 2);
    assert.equal(lod2Progress.sectors[0].excludedCount, 190);
    assert.equal(lod2Progress.sectors[0].status, "complete");
    assert.equal(lod2Progress.sectors[0].percent, 100);

    const lod1Response = await fetch(
      `${baseUrl}/api/local-atlas/coverage?layer=base&lod=1`,
    );
    assert.equal(lod1Response.status, 200);
    const lod1Snapshot = parseLocalAtlasCoverage(
      await lod1Response.json(),
    );
    assert.ok(lod1Snapshot);
    assert.deepEqual(lod1Snapshot.cells[0], {
      row: 0,
      column: 0,
      completeCount: 2,
      queuedCount: 0,
      failedCount: 0,
      absentCount: 766,
    });
    const lod1Progress = summarizeLocalCoverage(lod1Snapshot, 1);
    assert.ok(lod1Progress);
    assert.equal(lod1Progress.sectors[0].expectedCount, 2);
    assert.equal(lod1Progress.sectors[0].status, "complete");
    assert.equal(lod1Progress.sectors[0].percent, 100);

    const lod0Response = await fetch(
      `${baseUrl}/api/local-atlas/coverage?layer=base&lod=0`,
    );
    assert.equal(lod0Response.status, 200);
    const lod0Snapshot = parseLocalAtlasCoverage(
      await lod0Response.json(),
    );
    assert.ok(lod0Snapshot);
    assert.equal(lod0Snapshot.cells.length, 1);
    assert.deepEqual(lod0Snapshot.cells[0], {
      row: 0,
      column: 0,
      completeCount: 3,
      queuedCount: 0,
      failedCount: 0,
      absentCount: 3069,
    });
    const lod0Progress = summarizeLocalCoverage(lod0Snapshot, 0);
    assert.ok(lod0Progress);
    assert.equal(lod0Progress.sectors[0].expectedCount, 3);
    assert.equal(lod0Progress.sectors[0].status, "complete");
    assert.equal(lod0Progress.sectors[0].percent, 100);

    const invalid = await fetch(
      `${baseUrl}/api/local-atlas/coverage?layer=overlay&lod=3`,
    );
    assert.equal(invalid.status, 400);

    const denied = await fetch(
      `${baseUrl}/api/local-atlas/coverage?layer=base&lod=3`,
      { headers: { Origin: "https://evil.example" } },
    );
    assert.equal(denied.status, 403);
  });
});
