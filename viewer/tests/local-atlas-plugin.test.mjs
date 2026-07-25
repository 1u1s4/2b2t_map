import assert from "node:assert/strict";
import test from "node:test";

import {
  isLoopbackAddress,
  isLoopbackHost,
  parseRegionDownloadRequest,
} from "../build/local-atlas-vite-plugin.ts";
import { parseLocalAtlasRuntime } from "../app/lib/local-atlas-runtime.ts";

test("local atlas accepts one aligned regional cell and a bounded rate", () => {
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

test("local atlas rejects paths-by-proxy, unaligned ranges, and bulk work", () => {
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
    { ...valid, lod: 11 },
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
