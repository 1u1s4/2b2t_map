import assert from "node:assert/strict";
import test from "node:test";

import {
  isCompletedBaseCellRequest,
  parseLocalAtlasRuntime,
  parseLocalAtlasRegionStatus,
  regionJobMatchesBounds,
} from "../app/lib/local-atlas-runtime.ts";

const bounds = Object.freeze({
  minX: -85_504,
  minZ: 167_936,
  maxXExclusive: -52_736,
  maxZExclusive: 200_704,
});

const completeRegion = Object.freeze({
  version: 1,
  dimension: "overworld",
  lod: 0,
  bounds,
  layers: ["base", "overlay", "newchunks"],
  totalCount: 12_288,
  resolvedCount: 12_288,
  completeCount: 12_285,
  absentCount: 3,
  pendingCount: 0,
  failedCount: 0,
  missingCount: 0,
  percent: 100,
  ready: true,
  databaseUpdatedAt: "2026-07-25T12:00:00.000Z",
  absentCells: [
    { tileX: -167, tileZ: 328 },
    { tileX: -166, tileZ: 328 },
  ],
});

test("regional status accepts an exact durable complete snapshot", () => {
  assert.deepEqual(parseLocalAtlasRegionStatus(completeRegion), completeRegion);
});

test("regional status supports an empty catalog but never calls it ready", () => {
  const empty = {
    ...completeRegion,
    totalCount: 12_288,
    resolvedCount: 0,
    completeCount: 0,
    absentCount: 0,
    pendingCount: 0,
    failedCount: 0,
    missingCount: 12_288,
    percent: 0,
    ready: false,
    databaseUpdatedAt: null,
    absentCells: [],
  };
  assert.deepEqual(parseLocalAtlasRegionStatus(empty), empty);
});

test("regional status rejects contradictory counters, readiness, and absences", () => {
  for (const invalid of [
    { ...completeRegion, resolvedCount: 12_287 },
    { ...completeRegion, ready: false },
    { ...completeRegion, percent: 99 },
    {
      ...completeRegion,
      absentCells: [
        ...completeRegion.absentCells,
        completeRegion.absentCells[0],
      ],
    },
    { ...completeRegion, databaseUpdatedAt: "not-a-date" },
  ]) {
    assert.equal(
      parseLocalAtlasRegionStatus(invalid),
      null,
      JSON.stringify(invalid),
    );
  }
});

test("a completed regional job contains every base cell in its bounds", () => {
  const job = {
    id: "regional-job",
    status: "complete",
    request: {
      xMin: bounds.minX,
      zMin: bounds.minZ,
      xMaxExclusive: bounds.maxXExclusive,
      zMaxExclusive: bounds.maxZExclusive,
      lod: 0,
      layers: ["base", "overlay", "newchunks"],
      requestsPerSecond: 1,
    },
    startedAt: "2026-07-25T12:00:00.000Z",
    finishedAt: "2026-07-25T12:01:00.000Z",
    exitCode: 0,
    message: "Región disponible en la biblioteca local",
  };

  assert.equal(regionJobMatchesBounds(job, bounds), true);
  assert.equal(
    isCompletedBaseCellRequest(
      job,
      {
        minX: bounds.minX + 512,
        minZ: bounds.minZ + 512,
        maxXExclusive: bounds.minX + 1_024,
        maxZExclusive: bounds.minZ + 1_024,
      },
      0,
    ),
    true,
  );
  assert.equal(
    isCompletedBaseCellRequest(
      job,
      {
        minX: bounds.minX - 512,
        minZ: bounds.minZ,
        maxXExclusive: bounds.minX,
        maxZExclusive: bounds.minZ + 512,
      },
      0,
    ),
    false,
  );
});

test("browser runtime preserves bounded regional job progress", () => {
  const payload = {
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
      id: "regional-job",
      status: "running",
      request: {
        xMin: bounds.minX,
        zMin: bounds.minZ,
        xMaxExclusive: bounds.maxXExclusive,
        zMaxExclusive: bounds.maxZExclusive,
        lod: 0,
        layers: ["base", "overlay", "newchunks"],
        requestsPerSecond: 16,
      },
      startedAt: "2026-07-25T12:00:00.000Z",
      finishedAt: null,
      exitCode: null,
      message: "Descargando región · 25.0%",
      progress: {
        requested: 12_288,
        processed: 3_072,
        complete: 3_000,
        absent: 72,
        failed: 0,
        reused: 2_900,
        reusedAbsent: 72,
        downloadedBytes: 8_192,
        percent: 25,
        status: "running",
        requestAttempts: 256,
        elapsedSeconds: 32,
        tilesPerSecond: 96,
        bytesPerSecond: 256_000,
        etaSeconds: 96,
        effectiveRps: 8,
        targetRps: 16,
        cooldownSeconds: 8,
        cooldownUntil: "2026-07-25T12:00:40.000Z",
        networkRequested: 1_024,
        networkProcessed: 256,
        resolvedPerSecond: 96,
        networkTilesPerSecond: 8,
        achievedRps: 8,
      },
    },
  };
  const runtime = parseLocalAtlasRuntime(payload);

  assert.deepEqual(runtime?.job?.progress, {
    requested: 12_288,
    processed: 3_072,
    complete: 3_000,
    absent: 72,
    failed: 0,
    reused: 2_900,
    reusedAbsent: 72,
    downloadedBytes: 8_192,
    percent: 25,
    status: "running",
    requestAttempts: 256,
    elapsedSeconds: 32,
    tilesPerSecond: 96,
    bytesPerSecond: 256_000,
    etaSeconds: 96,
    effectiveRps: 8,
    targetRps: 16,
    cooldownSeconds: 8,
    cooldownUntil: "2026-07-25T12:00:40.000Z",
    networkRequested: 1_024,
    networkProcessed: 256,
    resolvedPerSecond: 96,
    networkTilesPerSecond: 8,
    achievedRps: 8,
  });
  assert.equal(
    runtime?.job?.progress?.tilesPerSecond,
    runtime?.job?.progress?.resolvedPerSecond,
  );
  assert.ok(
    (runtime?.job?.progress?.resolvedPerSecond ?? 0) >
      (runtime?.job?.progress?.networkTilesPerSecond ?? 0),
  );

  for (const invalidProgress of [
    { targetRps: 8 },
    { targetRps: 17 },
    { effectiveRps: 16.01 },
    { cooldownSeconds: 901 },
    { cooldownUntil: "not-a-timestamp" },
    { networkRequested: 12_289 },
    { networkProcessed: 1_025 },
    { tilesPerSecond: 95 },
    { networkTilesPerSecond: 8.01 },
    { resolvedPerSecond: 7 },
    { achievedRps: 7 },
  ]) {
    assert.equal(
      parseLocalAtlasRuntime({
        ...payload,
        job: {
          ...payload.job,
          progress: {
            ...payload.job.progress,
            ...invalidProgress,
          },
        },
      }),
      null,
      JSON.stringify(invalidProgress),
    );
  }
});
