import assert from "node:assert/strict";
import test from "node:test";

import {
  parseDownloadProgress,
  readDownloadProgress,
} from "../app/lib/download-progress.ts";

test("progress parser prefers explicit counters and percentage", () => {
  const progress = parseDownloadProgress({
    status: "RUNNING",
    updated_at: "2026-07-24T12:34:56Z",
    tiles_completed: 20,
    tiles_pending: 70,
    tiles_absent: 3,
    tiles_corrupt: 1,
    tiles_failed: 2,
    planned_requests: 100,
    processed_requests: 25,
    progress_percent: 24.75,
    progress_kind: "estimated",
    tiles_per_second: 1.98,
    megabytes_per_second: 0.19,
    data_downloaded_bytes: 1_073_741_824,
    eta_seconds: 4_200,
    effective_requests_per_second: 2,
    reason: "reintentando un grupo",
    http_errors: {
      404: 230,
      429: 2,
      nope: 99,
      500: -1,
    },
  });

  assert.equal(progress.status, "running");
  assert.equal(progress.updatedAtTimestamp, Date.parse("2026-07-24T12:34:56Z"));
  assert.equal(progress.plannedRequests, 100);
  assert.equal(progress.processedRequests, 25);
  assert.equal(progress.progressPercent, 24.75);
  assert.equal(progress.progressPercentSource, "reported");
  assert.equal(progress.progressKind, "estimated");
  assert.equal(progress.downloadedBytes, 1_073_741_824);
  assert.deepEqual(progress.httpErrors, [
    { code: "404", count: 230 },
    { code: "429", count: 2 },
  ]);
  assert.ok(Object.isFrozen(progress));
});

test("progress parser derives a useful fallback from legacy fields", () => {
  const progress = parseDownloadProgress({
    status: "running",
    tiles_completed: 8,
    tiles_absent: 2,
    tiles_pending: 30,
    space_used_bytes: 4096,
  });

  assert.equal(progress.processedRequests, 10);
  assert.equal(progress.plannedRequests, 40);
  assert.equal(progress.progressPercent, 25);
  assert.equal(progress.progressPercentSource, "derived");
  assert.equal(progress.downloadedBytes, 4096);
});

test("progress parser ignores unsafe optional fields without breaking the map", () => {
  const progress = parseDownloadProgress({
    status: "x".repeat(100),
    updated_at: "not-a-date",
    tiles_completed: -2,
    tiles_pending: "20",
    planned_requests: 10,
    processed_requests: 4,
    progress_percent: 500,
    eta_seconds: Number.POSITIVE_INFINITY,
    http_errors: [],
  });

  assert.equal(progress.status, "unknown");
  assert.equal(progress.updatedAt, null);
  assert.equal(progress.tilesCompleted, 0);
  assert.equal(progress.tilesPending, 0);
  assert.equal(progress.progressPercent, 40);
  assert.equal(progress.progressPercentSource, "derived");
  assert.equal(progress.etaSeconds, null);
  assert.deepEqual(progress.httpErrors, []);
  assert.throws(
    () => parseDownloadProgress(["not", "an", "object"]),
    /objeto JSON/,
  );
});

test("progress reader handles ready, missing, malformed, and oversized files", async () => {
  let reads = 0;
  const readyDirectory = {
    async getFileHandle(name, options) {
      assert.equal(name, "progress.json");
      assert.deepEqual(options, { create: false });
      return {
        async getFile() {
          reads += 1;
          return {
            size: 64,
            async text() {
              return '{"status":"complete","tiles_completed":12}';
            },
          };
        },
      };
    },
  };

  const first = await readDownloadProgress(readyDirectory);
  const second = await readDownloadProgress(readyDirectory);
  assert.equal(first.kind, "ready");
  assert.equal(second.kind, "ready");
  assert.equal(reads, 2, "each poll must acquire a fresh File");
  assert.equal(first.progress.progressPercent, 100);

  const missing = await readDownloadProgress({
    async getFileHandle() {
      throw new DOMException("missing", "NotFoundError");
    },
  });
  assert.equal(missing.kind, "missing");

  const malformed = await readDownloadProgress({
    async getFileHandle() {
      return {
        async getFile() {
          return { size: 8, async text() { return "{broken"; } };
        },
      };
    },
  });
  assert.equal(malformed.kind, "invalid");

  const oversized = await readDownloadProgress({
    async getFileHandle() {
      return {
        async getFile() {
          return { size: 1_000_001, async text() { return "{}"; } };
        },
      };
    },
  });
  assert.equal(oversized.kind, "invalid");
});
