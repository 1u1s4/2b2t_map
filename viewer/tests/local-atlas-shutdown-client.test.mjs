import assert from "node:assert/strict";
import test from "node:test";

import { shutdownLocalAtlasApplication } from "../app/lib/local-atlas-runtime.ts";

test("shutdown client sends only the ephemeral runtime token", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "/api/local-atlas/shutdown");
    assert.equal(init?.method, "POST");
    assert.equal(init?.cache, "no-store");
    assert.equal(init?.headers["X-Atlas-Token"], "local-token");
    assert.equal(init?.body, undefined);
    return new Response(JSON.stringify({ shuttingDown: true }), {
      status: 202,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    await shutdownLocalAtlasApplication({ mutationToken: "local-token" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("shutdown client preserves the server error and rejects malformed success", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: "Descarga todavía activa" }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      });
    await assert.rejects(
      shutdownLocalAtlasApplication({ mutationToken: "local-token" }),
      /Descarga todavía activa/,
    );

    globalThis.fetch = async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 202,
        headers: { "Content-Type": "application/json" },
      });
    await assert.rejects(
      shutdownLocalAtlasApplication({ mutationToken: "local-token" }),
      /no confirmó el apagado/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
