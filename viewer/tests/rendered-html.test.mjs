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
    /<meta name="description" content="Explora el Overworld de 2b2t por regiones, avanza celda por celda y guarda tu progreso local\."/i,
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
  assert.doesNotMatch(html, /DESCARGA COMPLETA|mchinchimoran\.chatgpt\.site/i);
  assert.doesNotMatch(
    html,
    /codex-preview|Building your site|Your site is taking shape|SkeletonPreview/i,
  );
});

test("tile API validates input before contacting an upstream", async () => {
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

test("tile API is local-only unless online access is explicit", async () => {
  const originalFetch = globalThis.fetch;
  let upstreamCalls = 0;
  globalThis.fetch = async () => {
    upstreamCalls += 1;
    throw new Error("local-only requests must not reach the network");
  };
  try {
    const response = await request(
      "/api/tile?layer=base&lod=0&dimension=0&tileX=0&tileZ=0&online=0",
    );
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-atlas-tile-source"), "local-miss");
    assert.equal(upstreamCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("tile API uses truncating negative shards and returns a cacheable WebP", async () => {
  const originalFetch = globalThis.fetch;
  const webpHeader = new Uint8Array([
    0x52, 0x49, 0x46, 0x46, 0x04, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
  ]);
  let upstreamUrl = "";
  let upstreamInit;

  globalThis.fetch = async (input, init) => {
    upstreamUrl = String(input);
    upstreamInit = init;
    return new Response(webpHeader, {
      status: 202,
      headers: {
        "Content-Type": "image/webp",
        ETag: '"tile-etag"',
      },
    });
  };

  try {
    const response = await request(
      "/api/tile?layer=overlay&lod=3&dimension=0&tileX=-33&tileZ=-31&online=1",
    );

    assert.equal(
      upstreamUrl,
      "https://2b2t.place/tiles/overlay/3/0/-1/0/t.-33.-31.webp",
    );
    assert.equal(upstreamInit.redirect, "manual");
    assert.ok(upstreamInit.signal instanceof AbortSignal);
    assert.equal(upstreamInit.signal.aborted, false);
    assert.match(
      new Headers(upstreamInit.headers).get("user-agent") ?? "",
      /2b2t-map-viewer/,
    );
    assert.equal(response.status, 202);
    assert.equal(response.headers.get("content-type"), "image/webp");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.match(response.headers.get("cache-control") ?? "", /s-maxage=604800/);
    assert.equal(response.headers.get("etag"), '"tile-etag"');
    assert.deepEqual(
      new Uint8Array(await response.arrayBuffer()),
      webpHeader,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("tile API keeps missing tiles empty and translates upstream failures", async () => {
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async () => new Response(null, { status: 404 });
    const missing = await request(
      "/api/tile?layer=base&lod=0&dimension=0&tileX=58000&tileZ=58000&online=1",
    );
    assert.equal(missing.status, 404);
    assert.equal(await missing.text(), "");
    assert.match(
      missing.headers.get("cache-control") ?? "",
      /s-maxage=3600/,
    );

    globalThis.fetch = async () => {
      throw new Error("simulated network outage");
    };
    const unavailable = await request(
      "/api/tile?layer=newchunks&lod=10&dimension=0&tileX=0&tileZ=0&online=1",
    );
    assert.equal(unavailable.status, 502);
    assert.equal(unavailable.headers.get("cache-control"), "no-store");
    assert.deepEqual(await unavailable.json(), {
      error: "Unable to reach the 2b2t.place tile service",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("tile API rejects non-WebP content before it can be cached", async () => {
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async () =>
      new Response("<html>upstream error page</html>", {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    const wrongType = await request(
      "/api/tile?layer=base&lod=0&dimension=0&tileX=0&tileZ=0&online=1",
    );
    assert.equal(wrongType.status, 502);
    assert.equal(wrongType.headers.get("cache-control"), "no-store");
    assert.deepEqual(await wrongType.json(), {
      error: "The 2b2t.place tile service returned a non-WebP content type",
    });

    globalThis.fetch = async () =>
      new Response(new Uint8Array([0x6e, 0x6f, 0x74, 0x2d, 0x77, 0x65, 0x62, 0x70]), {
        status: 202,
        headers: { "Content-Type": "image/webp" },
      });
    const wrongMagic = await request(
      "/api/tile?layer=overlay&lod=3&dimension=0&tileX=-33&tileZ=-31&online=1",
    );
    assert.equal(wrongMagic.status, 502);
    assert.equal(wrongMagic.headers.get("cache-control"), "no-store");
    assert.deepEqual(await wrongMagic.json(), {
      error: "The 2b2t.place tile service returned an invalid WebP payload",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("tile API aborts an upstream request when its deadline expires", async () => {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;

  globalThis.setTimeout = (callback, delay, ...args) =>
    originalSetTimeout(callback, delay === 10_000 ? 0 : delay, ...args);
  globalThis.fetch = async (_input, init) =>
    new Promise((_resolve, reject) => {
      assert.ok(init.signal instanceof AbortSignal);
      init.signal.addEventListener(
        "abort",
        () => reject(new DOMException("Aborted", "AbortError")),
        { once: true },
      );
    });

  try {
    const response = await request(
      "/api/tile?layer=base&lod=10&dimension=0&tileX=0&tileZ=0&online=1",
    );
    assert.equal(response.status, 502);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), {
      error: "The 2b2t.place tile service timed out",
    });
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("tile API rejects unsupported HTTP methods", async () => {
  const response = await request(
    "/api/tile?layer=base&lod=0&dimension=0&tileX=0&tileZ=0",
    { method: "POST" },
  );
  assert.equal(response.status, 405);
});
