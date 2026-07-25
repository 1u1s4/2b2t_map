import assert from "node:assert/strict";
import test from "node:test";

import {
  isLoopbackAddress,
  isLoopbackHost,
  parseLocalCoverageRequest,
  parseRegionDownloadRequest,
} from "../build/local-atlas-vite-plugin.ts";
import {
  isCompletedBaseCellRequest,
  parseLocalAtlasCoverage,
  parseLocalAtlasRuntime,
} from "../app/lib/local-atlas-runtime.ts";

test("local atlas accepts one aligned regional LOD 0 cell and a bounded rate", () => {
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
});

test("local atlas rejects non-LOD0, paths-by-proxy, unaligned ranges, and bulk work", () => {
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
      xMaxExclusive: 512 * 65,
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
