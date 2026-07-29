import assert from "node:assert/strict";
import test from "node:test";

import {
  applyLocalAtlasXaeroPreview,
  readLocalAtlasXaeroPreview,
} from "../app/lib/local-atlas-runtime.ts";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const explorationId = "region-ms2jbdu0:sector";

function removalPreview(overrides = {}) {
  return {
    version: 1,
    previewId: "a".repeat(64),
    workspaceId,
    workspaceRevision: 23,
    operation: "remove",
    scope: "exploration",
    explorationId,
    regionName: "Sector de prueba",
    minecraftOpen: false,
    canExport: true,
    hasChanges: true,
    sourceHighlights: 5,
    exportableHighlights: 2,
    selectedHighlights: 4,
    managedHighlights: 3,
    removableHighlights: 2,
    skippedAreas: 1,
    notesNotExported: 0,
    duplicateNames: 0,
    conflicts: 0,
    overworld: {
      existing: 3,
      added: 0,
      updated: 0,
      unchanged: 0,
      removed: 2,
      alreadyAbsent: 1,
      conflicts: 0,
      final: 1,
    },
    nether: {
      existing: 2,
      added: 0,
      updated: 0,
      unchanged: 0,
      removed: 1,
      alreadyAbsent: 1,
      conflicts: 0,
      final: 1,
    },
    ...overrides,
  };
}

test("Xaero preview encodes the opaque exploration scope", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  globalThis.fetch = async (input, init) => {
    requestedUrl = String(input);
    assert.equal(init?.cache, "no-store");
    return new Response(JSON.stringify(removalPreview()), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        ETag: `"atlas-${workspaceId}-23"`,
      },
    });
  };

  try {
    const preview = await readLocalAtlasXaeroPreview({
      operation: "remove",
      scope: { kind: "exploration", explorationId },
    });
    const url = new URL(requestedUrl, "http://localhost");
    assert.match(requestedUrl, /explorationId=region-ms2jbdu0%3Asector/);
    assert.equal(url.pathname, "/api/local-atlas/xaero-export/preview");
    assert.equal(url.searchParams.get("operation"), "remove");
    assert.equal(url.searchParams.get("scope"), "exploration");
    assert.equal(url.searchParams.get("explorationId"), explorationId);
    assert.equal(preview.regionName, "Sector de prueba");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Xaero apply repeats the preview operation and scope", async () => {
  const originalFetch = globalThis.fetch;
  const preview = removalPreview();
  let requestBody;
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "/api/local-atlas/xaero-export");
    assert.equal(init?.method, "POST");
    assert.equal(init?.headers["If-Match"], `"atlas-${workspaceId}-23"`);
    assert.equal(init?.headers["X-Atlas-Token"], "local-token");
    assert.match(init?.headers["X-Atlas-Write-Id"], /^[0-9a-f-]{36}$/i);
    requestBody = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({
        ...preview,
        canExport: false,
        hasChanges: false,
        committed: true,
        exportedAt: "2026-07-26T20:00:00.000Z",
        backupId:
          "2026-07-26T20-00-00.000Z-33333333-3333-4333-8333-333333333333",
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          ETag: `"atlas-${workspaceId}-23"`,
        },
      },
    );
  };

  try {
    const result = await applyLocalAtlasXaeroPreview(
      { mutationToken: "local-token" },
      preview,
    );
    assert.deepEqual(requestBody, {
      previewId: "a".repeat(64),
      operation: "remove",
      scope: "exploration",
      explorationId,
    });
    assert.equal(result.operation, "remove");
    assert.equal(result.committed, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
