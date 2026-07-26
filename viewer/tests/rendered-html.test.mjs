import assert from "node:assert/strict";
import test from "node:test";

const workerEntry = new URL("../dist/server/index.js", import.meta.url);

async function request(path = "/", init) {
  const workerUrl = new URL(workerEntry);
  workerUrl.searchParams.set(
    "test",
    `${process.pid}-${Date.now()}-${Math.random()}`,
  );
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(new URL(path, "http://localhost"), init),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the Obsidian Atlas product shell and metadata", async () => {
  const response = await request("/");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<html lang="es">/i);
  assert.match(
    html,
    /<title>Obsidian Atlas — visor del Overworld de 2b2t<\/title>/i,
  );
  assert.match(
    html,
    /<meta name="description" content="Descarga regiones completas del Overworld de 2b2t, explóralas celda por celda y guarda el progreso automáticamente\."/i,
  );
  assert.match(
    html,
    /<meta property="og:image" content="http:\/\/localhost:3001\/og\.png"/i,
  );
  assert.match(
    html,
    /<meta name="twitter:image" content="http:\/\/localhost:3001\/og\.png"/i,
  );
  assert.match(html, /OBSIDIAN ATLAS/);
  assert.match(html, /2b2t · exploración local/);
  assert.match(
    html,
    /<canvas[^>]+aria-label="Mapa interactivo del Overworld de 2b2t"/i,
  );
  assert.match(html, /Ir a coordenadas o highlight/);
  assert.match(html, /Solo local/);
  assert.match(html, /Explorar/);
  assert.match(html, /class="atlas-shell[^"]*is-atlas-mode/i);
  assert.match(html, /Mapa general/);
  assert.match(html, /Vista completa · Overworld/i);
  assert.match(html, /1,089 sectores en una sola vista/i);
  assert.match(html, /El mapa general no descarga archivos/i);
  assert.doesNotMatch(html, /descarga global/i);
  assert.doesNotMatch(html, /mchinchimoran\.chatgpt\.site/i);
  assert.doesNotMatch(
    html,
    /codex-preview|Building your site|Your site is taking shape|SkeletonPreview/i,
  );
});

test("tile API validates input without contacting the network", async () => {
  const originalFetch = globalThis.fetch;
  let upstreamCalls = 0;
  globalThis.fetch = async () => {
    upstreamCalls += 1;
    throw new Error("invalid requests must not reach an upstream");
  };

  try {
    const cases = [
      [
        "/api/tile?layer=https%3A%2F%2Fevil.example&lod=0&dimension=0&tileX=0&tileZ=0",
        "layer must be one of",
      ],
      [
        "/api/tile?layer=base&lod=11&dimension=0&tileX=0&tileZ=0",
        "lod must be between 0 and 10",
      ],
      [
        "/api/tile?layer=base&lod=0&dimension=1&tileX=0&tileZ=0",
        "dimension must be 0",
      ],
      [
        "/api/tile?layer=base&lod=0&dimension=0&tileX=0",
        "Missing required query parameter: tileZ",
      ],
      [
        "/api/tile?layer=base&lod=0&dimension=0&tileX=9007199254740992&tileZ=0",
        "tileX must be a safe integer",
      ],
      [
        "/api/tile?layer=base&lod=10&dimension=0&tileX=60&tileZ=0",
        "tileX and tileZ must be within ±59 at lod 10",
      ],
    ];

    for (const [path, expectedMessage] of cases) {
      const response = await request(path);
      assert.equal(response.status, 400);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const payload = await response.json();
      assert.match(payload.error, new RegExp(expectedMessage));
    }

    assert.equal(upstreamCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("tile API stays local-only even when a legacy online flag is supplied", async () => {
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = async () => {
    networkCalls += 1;
    throw new Error("tile requests must never reach the network");
  };

  try {
    const basePath =
      "/api/tile?layer=base&lod=0&dimension=0&tileX=0&tileZ=0";
    for (const suffix of ["", "&online=0", "&online=1"]) {
      const response = await request(`${basePath}${suffix}`);
      assert.equal(response.status, 404);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("x-atlas-tile-source"), "local-miss");
      assert.equal(await response.text(), "");
    }

    assert.equal(networkCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("tile API rejects unsupported HTTP methods", async () => {
  const response = await request(
    "/api/tile?layer=base&lod=0&dimension=0&tileX=0&tileZ=0",
    { method: "POST" },
  );
  assert.equal(response.status, 405);
});
