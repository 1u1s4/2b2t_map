import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createLocalAtlasMiddleware } from "../build/local-atlas-vite-plugin.ts";

function emptyContent() {
  return {
    schemaVersion: 1,
    activeExplorationId: null,
    explorations: [],
    highlights: [],
    coverageSelection: null,
    minecraftExploredSectorIds: [],
  };
}

async function withWorkspaceServer(operation) {
  const backingRoot = await mkdtemp(join(tmpdir(), "atlas-http-"));
  const runtime = createLocalAtlasMiddleware({ backingRoot });
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
    await rm(backingRoot, { recursive: true, force: true });
  }
}

test("workspace HTTP contract requires local origin, token, ETag, and write id", async () => {
  await withWorkspaceServer(async (baseUrl) => {
    const statusResponse = await fetch(`${baseUrl}/api/local-atlas/status`);
    assert.equal(statusResponse.status, 200);
    const status = await statusResponse.json();
    assert.equal(status.localOnly, true);
    assert.equal(status.persistence.configured, true);
    assert.equal(status.persistence.writable, true);
    assert.equal(status.persistence.volume, "LuisA");
    assert.equal(status.persistence.revision, null);
    assert.equal(typeof status.mutationToken, "string");

    const deniedOrigin = await fetch(
      `${baseUrl}/api/local-atlas/workspace`,
      {
        headers: { Origin: "https://evil.example" },
      },
    );
    assert.equal(deniedOrigin.status, 403);

    const emptyResponse = await fetch(
      `${baseUrl}/api/local-atlas/workspace`,
    );
    assert.equal(emptyResponse.status, 200);
    const empty = await emptyResponse.json();
    assert.equal(empty.revision, 0);
    assert.deepEqual(empty.minecraftExploredSectorIds, []);
    const emptyEtag = `"atlas-${empty.workspaceId}-0"`;
    assert.equal(emptyResponse.headers.get("etag"), emptyEtag);

    const noToken = await fetch(
      `${baseUrl}/api/local-atlas/workspace`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "If-Match": emptyEtag,
          "X-Atlas-Write-Id": randomUUID(),
        },
        body: JSON.stringify(emptyContent()),
      },
    );
    assert.equal(noToken.status, 403);

    const noPrecondition = await fetch(
      `${baseUrl}/api/local-atlas/workspace`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-Atlas-Token": status.mutationToken,
          "X-Atlas-Write-Id": randomUUID(),
        },
        body: JSON.stringify(emptyContent()),
      },
    );
    assert.equal(noPrecondition.status, 428);

    const writeId = randomUUID();
    const savedResponse = await fetch(
      `${baseUrl}/api/local-atlas/workspace`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "If-Match": emptyEtag,
          "X-Atlas-Token": status.mutationToken,
          "X-Atlas-Write-Id": writeId,
        },
        body: JSON.stringify(emptyContent()),
      },
    );
    assert.equal(savedResponse.status, 200);
    const saved = await savedResponse.json();
    assert.equal(saved.revision, 1);
    assert.equal(saved.lastWriteId, writeId);
    const savedEtag = `"atlas-${saved.workspaceId}-1"`;
    assert.equal(savedResponse.headers.get("etag"), savedEtag);

    const savedStatus = await fetch(`${baseUrl}/api/local-atlas/status`);
    assert.equal(savedStatus.status, 200);
    const statusAfterWrite = await savedStatus.json();
    assert.equal(statusAfterWrite.persistence.revision, 1);
    assert.equal(statusAfterWrite.persistence.updatedAt, saved.updatedAt);

    const retryResponse = await fetch(
      `${baseUrl}/api/local-atlas/workspace`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "If-Match": emptyEtag,
          "X-Atlas-Token": status.mutationToken,
          "X-Atlas-Write-Id": writeId,
        },
        body: JSON.stringify(emptyContent()),
      },
    );
    assert.equal(retryResponse.status, 200);
    assert.equal((await retryResponse.json()).revision, 1);

    const conflictResponse = await fetch(
      `${baseUrl}/api/local-atlas/workspace`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "If-Match": emptyEtag,
          "X-Atlas-Token": status.mutationToken,
          "X-Atlas-Write-Id": randomUUID(),
        },
        body: JSON.stringify(emptyContent()),
      },
    );
    assert.equal(conflictResponse.status, 412);
    assert.equal(conflictResponse.headers.get("etag"), savedEtag);
    const conflict = await conflictResponse.json();
    assert.equal(conflict.code, "WORKSPACE_CONFLICT");
    assert.equal(conflict.currentRevision, 1);
    assert.equal(conflict.current.revision, 1);

    const oversizedResponse = await fetch(
      `${baseUrl}/api/local-atlas/workspace`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "If-Match": savedEtag,
          "X-Atlas-Token": status.mutationToken,
          "X-Atlas-Write-Id": randomUUID(),
        },
        body: `"${"x".repeat(16 * 1024 * 1024)}"`,
      },
    );
    assert.equal(oversizedResponse.status, 413);
  });
});
