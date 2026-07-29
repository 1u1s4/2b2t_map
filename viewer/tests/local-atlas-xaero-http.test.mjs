import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createLocalAtlasMiddleware } from "../build/local-atlas-vite-plugin.ts";
import {
  createMaxDetailExplorationState,
  serializeExplorationState,
} from "../app/lib/exploration-grid.ts";

const HEADER = [
  "#",
  "#waypoint:name:initials:x:y:z:color:disabled:type:set:rotate_on_tp:tp_yaw:visibility_type:destination",
  "#",
  "waypoint:Existing:E:0:64:0:1:false:0:gui.xaero_default:false:0:0:false",
  "",
].join("\n");

async function withServer(operation) {
  const root = await mkdtemp(join(tmpdir(), "atlas-xaero-http-"));
  const backingRoot = join(root, "LuisA");
  const minecraftRoot = join(root, "minecraft");
  const waypointRoot = join(
    minecraftRoot,
    "xaero",
    "minimap",
    "Multiplayer_2b2t.org",
  );
  await Promise.all([
    mkdir(backingRoot, { recursive: true }),
    mkdir(join(waypointRoot, "dim%0"), { recursive: true }),
    mkdir(join(waypointRoot, "dim%-1"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(waypointRoot, "dim%0", "mw$default_1.txt"), HEADER),
    writeFile(join(waypointRoot, "dim%-1", "mw$default_1.txt"), HEADER),
  ]);
  const runtime = createLocalAtlasMiddleware({
    backingRoot,
    minecraftRoot,
    minecraftOpenProbe: async () => false,
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
    await operation(`http://127.0.0.1:${address.port}`);
  } finally {
    runtime.close();
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await rm(root, { recursive: true, force: true });
  }
}

test("Xaero HTTP preview and commit require local token and workspace revision", async () => {
  await withServer(async (baseUrl) => {
    const statusResponse = await fetch(`${baseUrl}/api/local-atlas/status`);
    const status = await statusResponse.json();
    const initialResponse = await fetch(
      `${baseUrl}/api/local-atlas/workspace`,
    );
    await initialResponse.json();
    const initialEtag = initialResponse.headers.get("etag");
    assert.ok(initialEtag);

    const content = {
      schemaVersion: 1,
      activeExplorationId: null,
      explorations: [],
      highlights: [
        {
          id: randomUUID(),
          type: "pin",
          title: "Portal",
          note: "",
          color: "#ff5f57",
          x: -9,
          z: 15,
          visible: true,
          createdAt: "2026-07-26T17:00:00.000Z",
        },
      ],
      coverageSelection: null,
    };
    const savedResponse = await fetch(
      `${baseUrl}/api/local-atlas/workspace`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "If-Match": initialEtag,
          "X-Atlas-Token": status.mutationToken,
          "X-Atlas-Write-Id": randomUUID(),
        },
        body: JSON.stringify(content),
      },
    );
    assert.equal(savedResponse.status, 200);
    const saved = await savedResponse.json();
    const savedEtag = savedResponse.headers.get("etag");
    assert.ok(savedEtag);

    const deniedOrigin = await fetch(
      `${baseUrl}/api/local-atlas/xaero-export/preview`,
      { headers: { Origin: "https://evil.example" } },
    );
    assert.equal(deniedOrigin.status, 403);

    const previewResponse = await fetch(
      `${baseUrl}/api/local-atlas/xaero-export/preview`,
    );
    assert.equal(previewResponse.status, 200);
    assert.equal(previewResponse.headers.get("etag"), savedEtag);
    const preview = await previewResponse.json();
    assert.equal(preview.overworld.added, 1);
    assert.equal(preview.nether.added, 1);
    assert.equal(preview.canExport, true);

    const withoutToken = await fetch(
      `${baseUrl}/api/local-atlas/xaero-export`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "If-Match": savedEtag,
        },
        body: JSON.stringify({ previewId: preview.previewId }),
      },
    );
    assert.equal(withoutToken.status, 403);

    const withoutRevision = await fetch(
      `${baseUrl}/api/local-atlas/xaero-export`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Atlas-Token": status.mutationToken,
        },
        body: JSON.stringify({ previewId: preview.previewId }),
      },
    );
    assert.equal(withoutRevision.status, 428);

    const withoutWriteId = await fetch(
      `${baseUrl}/api/local-atlas/xaero-export`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "If-Match": savedEtag,
          "X-Atlas-Token": status.mutationToken,
        },
        body: JSON.stringify({ previewId: preview.previewId }),
      },
    );
    assert.equal(withoutWriteId.status, 400);

    const pathInjection = await fetch(
      `${baseUrl}/api/local-atlas/xaero-export`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "If-Match": savedEtag,
          "X-Atlas-Token": status.mutationToken,
          "X-Atlas-Write-Id": randomUUID(),
        },
        body: JSON.stringify({
          previewId: preview.previewId,
          path: "/tmp/unsafe",
        }),
      },
    );
    assert.equal(pathInjection.status, 400);

    const xaeroWriteId = randomUUID();
    const committedResponse = await fetch(
      `${baseUrl}/api/local-atlas/xaero-export`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "If-Match": savedEtag,
          "X-Atlas-Token": status.mutationToken,
          "X-Atlas-Write-Id": xaeroWriteId,
        },
        body: JSON.stringify({ previewId: preview.previewId }),
      },
    );
    assert.equal(committedResponse.status, 200);
    const committed = await committedResponse.json();
    assert.equal(committed.committed, true);
    assert.equal(committed.overworld.added, 1);
    assert.equal(committed.nether.added, 1);

    const retriedResponse = await fetch(
      `${baseUrl}/api/local-atlas/xaero-export`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "If-Match": savedEtag,
          "X-Atlas-Token": status.mutationToken,
          "X-Atlas-Write-Id": xaeroWriteId,
        },
        body: JSON.stringify({ previewId: preview.previewId }),
      },
    );
    assert.equal(retriedResponse.status, 200);
    assert.deepEqual(await retriedResponse.json(), committed);

    const synchronizedResponse = await fetch(
      `${baseUrl}/api/local-atlas/xaero-export/preview`,
    );
    const synchronized = await synchronizedResponse.json();
    assert.equal(synchronized.hasChanges, false);
    assert.equal(synchronized.overworld.unchanged, 1);
    assert.equal(synchronized.nether.unchanged, 1);

    const nextSavedResponse = await fetch(
      `${baseUrl}/api/local-atlas/workspace`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "If-Match": savedEtag,
          "X-Atlas-Token": status.mutationToken,
          "X-Atlas-Write-Id": randomUUID(),
        },
        body: JSON.stringify(content),
      },
    );
    assert.equal(nextSavedResponse.status, 200);
    assert.equal((await nextSavedResponse.json()).revision, saved.revision + 1);

    const staleCommit = await fetch(
      `${baseUrl}/api/local-atlas/xaero-export`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "If-Match": savedEtag,
          "X-Atlas-Token": status.mutationToken,
          "X-Atlas-Write-Id": randomUUID(),
        },
        body: JSON.stringify({ previewId: synchronized.previewId }),
      },
    );
    assert.equal(staleCommit.status, 412);
  });
});

test("Xaero HTTP applies an encoded exploration scope to export and remove", async () => {
  await withServer(async (baseUrl) => {
    const status = await (
      await fetch(`${baseUrl}/api/local-atlas/status`)
    ).json();
    const initialResponse = await fetch(
      `${baseUrl}/api/local-atlas/workspace`,
    );
    await initialResponse.json();
    const initialEtag = initialResponse.headers.get("etag");
    assert.ok(initialEtag);

    const explorationId = "region:http";
    const state = JSON.parse(
      serializeExplorationState(
        createMaxDetailExplorationState({
          id: explorationId,
          name: "Región HTTP",
          bounds: {
            minX: -512,
            minZ: -512,
            maxXExclusive: 0,
            maxZExclusive: 0,
          },
        }),
      ),
    );
    const content = {
      schemaVersion: 1,
      activeExplorationId: explorationId,
      explorations: [
        {
          id: explorationId,
          createdAt: "2026-07-26T17:00:00.000Z",
          updatedAt: "2026-07-26T17:00:00.000Z",
          state,
        },
      ],
      highlights: [
        {
          id: randomUUID(),
          type: "pin",
          title: "Incluido",
          note: "",
          color: "#26d9c7",
          x: -512,
          z: -512,
          visible: true,
          createdAt: "2026-07-26T17:00:00.000Z",
        },
        {
          id: randomUUID(),
          type: "pin",
          title: "Máximo excluido",
          note: "",
          color: "#62a8ff",
          x: 0,
          z: -1,
          visible: true,
          createdAt: "2026-07-26T17:00:00.000Z",
        },
      ],
      coverageSelection: null,
    };
    const savedResponse = await fetch(
      `${baseUrl}/api/local-atlas/workspace`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "If-Match": initialEtag,
          "X-Atlas-Token": status.mutationToken,
          "X-Atlas-Write-Id": randomUUID(),
        },
        body: JSON.stringify(content),
      },
    );
    assert.equal(savedResponse.status, 200);
    const savedEtag = savedResponse.headers.get("etag");
    assert.ok(savedEtag);

    const missingId = await fetch(
      `${baseUrl}/api/local-atlas/xaero-export/preview?operation=export&scope=exploration`,
    );
    assert.equal(missingId.status, 400);
    const invalidOperation = await fetch(
      `${baseUrl}/api/local-atlas/xaero-export/preview?operation=delete&scope=all`,
    );
    assert.equal(invalidOperation.status, 400);

    const query = new URLSearchParams({
      operation: "export",
      scope: "exploration",
      explorationId,
    });
    const preview = await (
      await fetch(
        `${baseUrl}/api/local-atlas/xaero-export/preview?${query}`,
      )
    ).json();
    assert.equal(preview.operation, "export");
    assert.equal(preview.scope, "exploration");
    assert.equal(preview.explorationId, explorationId);
    assert.equal(preview.regionName, "Región HTTP");
    assert.equal(preview.selectedHighlights, 1);
    assert.equal(preview.exportableHighlights, 1);

    const mismatchedOperation = await fetch(
      `${baseUrl}/api/local-atlas/xaero-export`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "If-Match": savedEtag,
          "X-Atlas-Token": status.mutationToken,
          "X-Atlas-Write-Id": randomUUID(),
        },
        body: JSON.stringify({
          previewId: preview.previewId,
          operation: "remove",
          scope: "exploration",
          explorationId,
        }),
      },
    );
    assert.equal(mismatchedOperation.status, 409);

    const exportResponse = await fetch(
      `${baseUrl}/api/local-atlas/xaero-export`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "If-Match": savedEtag,
          "X-Atlas-Token": status.mutationToken,
          "X-Atlas-Write-Id": randomUUID(),
        },
        body: JSON.stringify({
          previewId: preview.previewId,
          operation: "export",
          scope: "exploration",
          explorationId,
        }),
      },
    );
    assert.equal(exportResponse.status, 200);

    const removeQuery = new URLSearchParams({
      operation: "remove",
      scope: "exploration",
      explorationId,
    });
    const removePreview = await (
      await fetch(
        `${baseUrl}/api/local-atlas/xaero-export/preview?${removeQuery}`,
      )
    ).json();
    assert.equal(removePreview.managedHighlights, 1);
    assert.equal(removePreview.removableHighlights, 1);
    assert.equal(removePreview.overworld.removed, 1);
    assert.equal(removePreview.nether.removed, 1);

    const removeWriteId = randomUUID();
    const removeBody = {
      previewId: removePreview.previewId,
      operation: "remove",
      scope: "exploration",
      explorationId,
    };
    const removeResponse = await fetch(
      `${baseUrl}/api/local-atlas/xaero-export`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "If-Match": savedEtag,
          "X-Atlas-Token": status.mutationToken,
          "X-Atlas-Write-Id": removeWriteId,
        },
        body: JSON.stringify(removeBody),
      },
    );
    assert.equal(removeResponse.status, 200);
    const removed = await removeResponse.json();
    assert.equal(removed.operation, "remove");
    assert.equal(removed.committed, true);

    const retried = await fetch(
      `${baseUrl}/api/local-atlas/xaero-export`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "If-Match": savedEtag,
          "X-Atlas-Token": status.mutationToken,
          "X-Atlas-Write-Id": removeWriteId,
        },
        body: JSON.stringify(removeBody),
      },
    );
    assert.equal(retried.status, 200);
    assert.deepEqual(await retried.json(), removed);

    const synchronized = await (
      await fetch(
        `${baseUrl}/api/local-atlas/xaero-export/preview?${removeQuery}`,
      )
    ).json();
    assert.equal(synchronized.hasChanges, false);
    assert.equal(synchronized.managedHighlights, 0);
  });
});
