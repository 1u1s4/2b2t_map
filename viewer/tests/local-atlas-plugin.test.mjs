import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  createLocalAtlasMiddleware,
  isLoopbackAddress,
  isLoopbackHost,
  parseLocalCoverageRequest,
  parseLocalRegionStatusRequest,
  parseRegionDownloadRequest,
} from "../build/local-atlas-vite-plugin.ts";
import {
  isCompletedBaseCellRequest,
  parseLocalAtlasCoverage,
  parseLocalAtlasRuntime,
} from "../app/lib/local-atlas-runtime.ts";

test("local atlas accepts an aligned regional LOD 0 inventory and a bounded rate", () => {
  assert.deepEqual(
    parseRegionDownloadRequest({
      xMin: -85_504,
      zMin: 167_936,
      xMaxExclusive: -84_992,
      zMaxExclusive: 168_448,
      lod: 0,
      layers: ["base", "overlay", "base"],
      requestsPerSecond: 2,
    }),
    {
      xMin: -85_504,
      zMin: 167_936,
      xMaxExclusive: -84_992,
      zMaxExclusive: 168_448,
      lod: 0,
      layers: ["base", "overlay"],
      requestsPerSecond: 2,
    },
  );
  const maximum = parseRegionDownloadRequest({
    xMin: 0,
    zMin: 0,
    xMaxExclusive: 1_024 * 512,
    zMaxExclusive: 1_024 * 512,
    lod: 0,
    layers: ["newchunks", "base", "overlay"],
    requestsPerSecond: 0.25,
  });
  assert.deepEqual(maximum.layers, ["base", "overlay", "newchunks"]);
});

test("local atlas rejects non-LOD0, paths-by-proxy, unaligned, and unsafe bulk work", () => {
  const valid = {
    xMin: 0,
    zMin: 0,
    xMaxExclusive: 512,
    zMaxExclusive: 512,
    lod: 0,
    layers: ["base"],
    requestsPerSecond: 1,
  };
  const invalid = [
    { ...valid, xMin: "/Volumes/LuisA" },
    { ...valid, xMin: 1 },
    { ...valid, xMaxExclusive: 0 },
    { ...valid, lod: 1 },
    { ...valid, lod: 11 },
    { ...valid, layers: ["overlay"] },
    { ...valid, layers: ["newchunks"] },
    { ...valid, layers: ["../../private"] },
    { ...valid, requestsPerSecond: 0 },
    {
      ...valid,
      xMaxExclusive: 512 * 1_025,
      zMaxExclusive: 512 * 1_024,
    },
  ];
  for (const payload of invalid) {
    assert.throws(
      () => parseRegionDownloadRequest(payload),
      undefined,
      JSON.stringify(payload),
    );
  }
});

test("local atlas recognizes loopback clients and hosts only", () => {
  for (const address of [
    "::1",
    "127.0.0.1",
    "127.8.9.10",
    "::ffff:127.0.0.1",
  ]) {
    assert.equal(isLoopbackAddress(address), true, address);
  }
  for (const address of [
    undefined,
    "0.0.0.0",
    "192.168.1.2",
    "::ffff:192.168.1.2",
  ]) {
    assert.equal(isLoopbackAddress(address), false, String(address));
  }

  for (const host of [
    "localhost",
    "localhost:3001",
    "127.0.0.1:3001",
    "[::1]:3001",
  ]) {
    assert.equal(isLoopbackHost(host), true, host);
  }
  for (const host of [undefined, "evil.example", "192.168.1.2:3001"]) {
    assert.equal(isLoopbackHost(host), false, String(host));
  }
});

test("browser runtime accepts only the projected local capability", () => {
  const runtime = parseLocalAtlasRuntime({
    localOnly: true,
    mutationToken: "12345678-1234-4234-9234-123456789abc",
    capacity: {
      configured: true,
      volume: "LuisA",
      totalBytes: 2_000_000,
      freeBytes: 1_500_000,
      archiveBytes: 10_000,
      availableForAtlasBytes: 1_500_000,
      overworldRequirementBytes: 1_400_000,
      marginBytes: 100_000,
      fits: true,
    },
    job: null,
    path: "/Volumes/LuisA/private",
  });
  assert.equal(runtime?.capacity.fits, true);
  assert.equal("path" in runtime, false);
  assert.equal(
    parseLocalAtlasRuntime({
      ...runtime,
      mutationToken: "short",
    }),
    null,
  );
});

test("browser runtime preserves the exact local cell request for completed jobs", () => {
  const runtime = parseLocalAtlasRuntime({
    localOnly: true,
    mutationToken: "12345678-1234-4234-9234-123456789abc",
    capacity: {
      configured: true,
      volume: "LuisA",
      totalBytes: 2_000_000,
      freeBytes: 1_500_000,
      archiveBytes: 10_000,
      availableForAtlasBytes: 1_500_000,
      overworldRequirementBytes: 1_400_000,
      marginBytes: 100_000,
      fits: true,
    },
    job: {
      id: "job-lod0",
      status: "complete",
      request: {
        xMin: -512,
        zMin: 0,
        xMaxExclusive: 0,
        zMaxExclusive: 512,
        lod: 0,
        layers: ["base", "overlay"],
        requestsPerSecond: 1,
      },
      startedAt: "2026-07-25T12:00:00.000Z",
      finishedAt: "2026-07-25T12:01:00.000Z",
      exitCode: 0,
      message: "Celda disponible en la biblioteca local",
    },
  });

  assert.deepEqual(runtime?.job?.request, {
    xMin: -512,
    zMin: 0,
    xMaxExclusive: 0,
    zMaxExclusive: 512,
    lod: 0,
    layers: ["base", "overlay"],
    requestsPerSecond: 1,
  });
  assert.equal(
    isCompletedBaseCellRequest(
      runtime.job,
      {
        minX: -512,
        minZ: 0,
        maxXExclusive: 0,
        maxZExclusive: 512,
      },
      0,
    ),
    true,
  );
  assert.equal(
    isCompletedBaseCellRequest(
      runtime.job,
      {
        minX: 0,
        minZ: 0,
        maxXExclusive: 512,
        maxZExclusive: 512,
      },
      0,
    ),
    false,
  );
});

test("coverage requests accept only the fixed base layer and LOD 0 to 3", () => {
  assert.deepEqual(
    parseLocalCoverageRequest(
      "/api/local-atlas/coverage?layer=base&lod=0",
    ),
    { lod: 0 },
  );
  assert.deepEqual(
    parseLocalCoverageRequest(
      "/api/local-atlas/coverage?lod=3&layer=base",
    ),
    { lod: 3 },
  );
  for (const invalid of [
    undefined,
    "/api/local-atlas/coverage",
    "/api/local-atlas/coverage?layer=overlay&lod=0",
    "/api/local-atlas/coverage?layer=base&lod=-1",
    "/api/local-atlas/coverage?layer=base&lod=4",
    "/api/local-atlas/coverage?layer=base&lod=01",
    "/api/local-atlas/status?layer=base&lod=0",
  ]) {
    assert.equal(
      parseLocalCoverageRequest(invalid),
      null,
      String(invalid),
    );
  }
});

test("regional status requests are canonical, aligned, LOD 0, and bounded", () => {
  assert.deepEqual(
    parseLocalRegionStatusRequest(
      "/api/local-atlas/region-status?xMin=-512&zMin=0&xMaxExclusive=512&zMaxExclusive=1024&lod=0&layers=newchunks,base,overlay",
    ),
    {
      bounds: {
        minX: -512,
        minZ: 0,
        maxXExclusive: 512,
        maxZExclusive: 1024,
      },
      lod: 0,
      layers: ["base", "overlay", "newchunks"],
    },
  );
  for (const invalid of [
    undefined,
    "/api/local-atlas/region-status",
    "/api/local-atlas/region-status?xMin=0&zMin=0&xMaxExclusive=512&zMaxExclusive=512&lod=1&layers=base",
    "/api/local-atlas/region-status?xMin=1&zMin=0&xMaxExclusive=512&zMaxExclusive=512&lod=0&layers=base",
    "/api/local-atlas/region-status?xMin=0&zMin=0&xMaxExclusive=512&zMaxExclusive=512&lod=0&layers=overlay",
    "/api/local-atlas/region-status?xMin=0&zMin=0&xMaxExclusive=512&zMaxExclusive=512&lod=0&layers=base&layers=overlay",
    "/api/local-atlas/region-status?xMin=0&zMin=0&xMaxExclusive=512&zMaxExclusive=512&lod=0&layers=base&path=/tmp",
    `/api/local-atlas/region-status?xMin=0&zMin=0&xMaxExclusive=${512 * 1_025}&zMaxExclusive=${512 * 1_024}&lod=0&layers=base`,
    "/api/local-atlas/status?xMin=0&zMin=0&xMaxExclusive=512&zMaxExclusive=512&lod=0&layers=base",
  ]) {
    assert.equal(
      parseLocalRegionStatusRequest(invalid),
      null,
      String(invalid),
    );
  }
});

test("browser coverage parser rejects duplicate or non-canonical cells", () => {
  const cell = {
    row: 0,
    column: 0,
    completeCount: 32,
    queuedCount: 1,
    failedCount: 3,
    absentCount: 4,
  };
  const snapshot = {
    version: 1,
    dimension: "overworld",
    layer: "base",
    lod: 3,
    databaseUpdatedAt: "2026-07-25T00:00:00.000Z",
    cells: [cell],
  };
  assert.deepEqual(parseLocalAtlasCoverage(snapshot), snapshot);
  assert.equal(
    parseLocalAtlasCoverage({ ...snapshot, cells: [cell, cell] }),
    null,
  );
  assert.equal(
    parseLocalAtlasCoverage({
      ...snapshot,
      cells: [{ ...cell, failedCount: -1 }],
    }),
    null,
  );
  assert.equal(
    parseLocalAtlasCoverage({
      ...snapshot,
      cells: [{ ...cell, absentCount: -1 }],
    }),
    null,
  );
  assert.equal(
    parseLocalAtlasCoverage({
      ...snapshot,
      databaseUpdatedAt: "not-a-timestamp",
    }),
    null,
  );
});

const SQLITE_SCHEMA = `
CREATE TABLE tiles (
  dimension TEXT NOT NULL,
  layer TEXT NOT NULL,
  lod INTEGER NOT NULL,
  tile_x INTEGER NOT NULL,
  tile_z INTEGER NOT NULL,
  status TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  size_bytes INTEGER
);
`;

function seedTileDatabase(databasePath, rows) {
  execFileSync(
    "python3",
    [
      "-c",
      `
import json
import sqlite3
import sys

database_path = sys.argv[1]
schema = sys.argv[2]
rows = json.loads(sys.argv[3])
connection = sqlite3.connect(database_path)
connection.executescript(schema)
connection.executemany(
    """
    INSERT INTO tiles(
      dimension, layer, lod, tile_x, tile_z, status, relative_path, size_bytes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    """,
    rows,
)
connection.commit()
connection.close()
`,
      databasePath,
      SQLITE_SCHEMA,
      JSON.stringify(rows),
    ],
    { stdio: "pipe" },
  );
}

async function writeWebpHeader(path) {
  await mkdir(join(path, ".."), { recursive: true });
  const header = Buffer.alloc(12);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(4, 4);
  header.write("WEBP", 8, "ascii");
  await writeFile(path, header);
}

async function invokeLocalMiddleware(runtime, url, init = {}) {
  return await new Promise((resolve, reject) => {
    const headers = new Map();
    const response = {
      statusCode: 200,
      setHeader(name, value) {
        headers.set(String(name).toLowerCase(), String(value));
      },
      end(chunk) {
        const body = chunk ? Buffer.from(chunk).toString("utf8") : "";
        resolve({
          status: response.statusCode,
          headers,
          body,
          json: body ? JSON.parse(body) : null,
        });
      },
    };
    const encodedBody =
      init.json === undefined
        ? null
        : Buffer.from(JSON.stringify(init.json), "utf8");
    const request = {
      url,
      method: init.method ?? "GET",
      headers: {
        host: "localhost:3001",
        ...(encodedBody ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
      socket: { remoteAddress: "127.0.0.1" },
      async *[Symbol.asyncIterator]() {
        if (encodedBody) yield encodedBody;
      },
    };
    Promise.resolve(
      runtime.middleware(request, response, (error) => {
        reject(error ?? new Error(`Unexpected middleware fallthrough: ${url}`));
      }),
    ).catch(reject);
  });
}

test("regional status is exact, validates files, resolves 404s, and survives runtime restarts", async (context) => {
  const tileRoot = await mkdtemp(join(tmpdir(), "atlas-region-status-"));
  context.after(async () => {
    await rm(tileRoot, { recursive: true, force: true });
  });

  const baseComplete = "base/0/overworld/0/0/t.0.0.webp";
  const overlayComplete = "overlay/0/overworld/0/0/t.0.1.webp";
  await writeWebpHeader(join(tileRoot, baseComplete));
  await writeWebpHeader(join(tileRoot, overlayComplete));
  seedTileDatabase(join(tileRoot, "tiles.sqlite3"), [
    ["overworld", "base", 0, 0, 0, "complete", baseComplete, 12],
    ["overworld", "base", 0, 1, 0, "absent", "unused-base-1-0.webp", null],
    ["overworld", "base", 0, 0, 1, "pending", "unused-base-0-1.webp", null],
    [
      "overworld",
      "overlay",
      0,
      0,
      0,
      "complete",
      "overlay/0/overworld/0/0/t.0.0.webp",
      12,
    ],
    [
      "overworld",
      "overlay",
      0,
      1,
      0,
      "corrupt",
      "unused-overlay-1-0.webp",
      null,
    ],
    ["overworld", "overlay", 0, 0, 1, "complete", overlayComplete, 12],
    [
      "overworld",
      "overlay",
      0,
      1,
      1,
      "absent",
      "unused-overlay-1-1.webp",
      null,
    ],
  ]);

  const url =
    "/api/local-atlas/region-status?xMin=0&zMin=0&xMaxExclusive=1024&zMaxExclusive=1024&lod=0&layers=overlay,base";
  const firstRuntime = createLocalAtlasMiddleware({
    tileRoot,
    pythonBin: "python3",
  });
  const first = await invokeLocalMiddleware(firstRuntime, url);
  firstRuntime.close();

  assert.equal(first.status, 200);
  assert.deepEqual(
    {
      ...first.json,
      databaseUpdatedAt: null,
    },
    {
      version: 1,
      dimension: "overworld",
      lod: 0,
      bounds: {
        minX: 0,
        minZ: 0,
        maxXExclusive: 1024,
        maxZExclusive: 1024,
      },
      layers: ["base", "overlay"],
      totalCount: 8,
      resolvedCount: 4,
      completeCount: 2,
      absentCount: 2,
      pendingCount: 1,
      failedCount: 1,
      missingCount: 2,
      percent: 50,
      ready: false,
      databaseUpdatedAt: null,
      absentCells: [{ tileX: 1, tileZ: 0 }],
    },
  );
  assert.match(first.json.databaseUpdatedAt, /^\d{4}-\d{2}-\d{2}T/);

  const restartedRuntime = createLocalAtlasMiddleware({
    tileRoot,
    pythonBin: "python3",
  });
  const afterRestart = await invokeLocalMiddleware(restartedRuntime, url);
  assert.deepEqual(afterRestart.json, first.json);

  const absentReady = await invokeLocalMiddleware(
    restartedRuntime,
    "/api/local-atlas/region-status?xMin=512&zMin=0&xMaxExclusive=1024&zMaxExclusive=512&lod=0&layers=base",
  );
  restartedRuntime.close();
  assert.deepEqual(
    {
      ...absentReady.json,
      databaseUpdatedAt: null,
    },
    {
      version: 1,
      dimension: "overworld",
      lod: 0,
      bounds: {
        minX: 512,
        minZ: 0,
        maxXExclusive: 1024,
        maxZExclusive: 512,
      },
      layers: ["base"],
      totalCount: 1,
      resolvedCount: 1,
      completeCount: 0,
      absentCount: 1,
      pendingCount: 0,
      failedCount: 0,
      missingCount: 0,
      percent: 100,
      ready: true,
      databaseUpdatedAt: null,
      absentCells: [{ tileX: 1, tileZ: 0 }],
    },
  );
});

test("regional status reports an empty catalog as entirely missing", async (context) => {
  const tileRoot = await mkdtemp(join(tmpdir(), "atlas-empty-status-"));
  context.after(async () => {
    await rm(tileRoot, { recursive: true, force: true });
  });
  const runtime = createLocalAtlasMiddleware({ tileRoot });
  const response = await invokeLocalMiddleware(
    runtime,
    "/api/local-atlas/region-status?xMin=0&zMin=0&xMaxExclusive=512&zMaxExclusive=512&lod=0&layers=base",
  );
  runtime.close();
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, {
    version: 1,
    dimension: "overworld",
    lod: 0,
    bounds: {
      minX: 0,
      minZ: 0,
      maxXExclusive: 512,
      maxZExclusive: 512,
    },
    layers: ["base"],
    totalCount: 1,
    resolvedCount: 0,
    completeCount: 0,
    absentCount: 0,
    pendingCount: 0,
    failedCount: 0,
    missingCount: 1,
    percent: 0,
    ready: false,
    databaseUpdatedAt: null,
    absentCells: [],
  });
});

test("regional jobs expose bounded JSONL progress without using it as readiness", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "atlas-job-progress-"));
  const tileRoot = join(root, "tiles");
  const projectRoot = join(root, "project");
  await mkdir(tileRoot, { recursive: true });
  await mkdir(projectRoot, { recursive: true });
  context.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(
    join(projectRoot, "download_region_2b2t.py"),
    `
import json

def emit(event, status, processed):
    print(json.dumps({
        "type": "region-download",
        "version": 1,
        "event": event,
        "status": status,
        "requested": 1,
        "processed": processed,
        "complete": processed,
        "absent": 0,
        "failed": 0,
        "reused": processed,
        "reusedAbsent": 0,
        "downloadedBytes": 0,
        "interrupted": False,
        "percent": processed * 100,
        "stopReason": None,
    }), flush=True)

emit("start", "running", 0)
emit("progress", "running", 1)
emit("summary", "complete", 1)
`,
    "utf8",
  );

  const runtime = createLocalAtlasMiddleware({
    tileRoot,
    projectRoot,
    pythonBin: "python3",
  });
  const initialStatus = await invokeLocalMiddleware(
    runtime,
    "/api/local-atlas/status",
  );
  const started = await invokeLocalMiddleware(
    runtime,
    "/api/local-atlas/download",
    {
      method: "POST",
      headers: {
        "x-atlas-token": initialStatus.json.mutationToken,
      },
      json: {
        xMin: 0,
        zMin: 0,
        xMaxExclusive: 512,
        zMaxExclusive: 512,
        lod: 0,
        layers: ["base"],
        requestsPerSecond: 1,
      },
    },
  );
  assert.equal(started.status, 202);
  assert.deepEqual(started.json.job.progress, {
    requested: 1,
    processed: 0,
    complete: 0,
    absent: 0,
    failed: 0,
    reused: 0,
    reusedAbsent: 0,
    downloadedBytes: 0,
    percent: 0,
    status: "running",
  });

  let terminal;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await delay(25);
    terminal = await invokeLocalMiddleware(
      runtime,
      "/api/local-atlas/status",
    );
    if (terminal.json.job?.status === "complete") break;
  }
  runtime.close();
  assert.equal(terminal?.json.job.status, "complete");
  assert.match(terminal.json.job.message, /Región disponible/);
  assert.deepEqual(terminal.json.job.progress, {
    requested: 1,
    processed: 1,
    complete: 1,
    absent: 0,
    failed: 0,
    reused: 1,
    reusedAbsent: 0,
    downloadedBytes: 0,
    percent: 100,
    status: "complete",
  });

  const regionStatus = createLocalAtlasMiddleware({ tileRoot });
  const durable = await invokeLocalMiddleware(
    regionStatus,
    "/api/local-atlas/region-status?xMin=0&zMin=0&xMaxExclusive=512&zMaxExclusive=512&lod=0&layers=base",
  );
  regionStatus.close();
  assert.equal(durable.json.ready, false);
  assert.equal(durable.json.missingCount, 1);
});
