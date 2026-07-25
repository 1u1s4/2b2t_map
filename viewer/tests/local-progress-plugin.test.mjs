import assert from "node:assert/strict";
import test from "node:test";

import { GET as productionGET } from "../app/api/local-progress/route.ts";
import {
  isLocalProgressPath,
  isLoopbackAddress,
  isLoopbackHost,
  projectProgressPayload,
} from "../build/local-progress-vite-plugin.ts";

test("local bridge projects only the fields consumed by the progress UI", () => {
  const projected = projectProgressPayload({
    status: "running",
    updated_at: "2026-07-25T03:00:00Z",
    planned_requests: 100,
    processed_requests: 4,
    progress_percent: 4,
    reason: "Protección HTTP 429 activa",
    http_errors: { 404: 2, nope: 7, 500: -1 },
    output: "/Volumes/private/2b2t_tiles",
    resume_command: "python /Users/private/download_all_2b2t.py",
    secret: "must-not-leak",
  });

  assert.deepEqual(projected, {
    status: "running",
    updated_at: "2026-07-25T03:00:00Z",
    planned_requests: 100,
    processed_requests: 4,
    progress_percent: 4,
    reason: "Protección HTTP 429 activa",
    http_errors: { 404: 2 },
  });
  assert.equal(JSON.stringify(projected).includes("/Users/"), false);
  assert.equal(JSON.stringify(projected).includes("/Volumes/"), false);
});

test("local bridge redacts a stop reason that contains machine paths", () => {
  const projected = projectProgressPayload({
    status: "stopped",
    reason: "Sin espacio en /Volumes/LuisA; reanuda con --out /Volumes/LuisA/map",
  });

  assert.equal(
    projected.reason,
    "El descargador reportó un problema; revisa download.log para ver el detalle local.",
  );
  assert.equal(JSON.stringify(projected).includes("/Volumes/"), false);
});

test("local bridge matches one exact endpoint and loopback origins only", () => {
  assert.equal(isLocalProgressPath("/api/local-progress"), true);
  assert.equal(isLocalProgressPath("/api/local-progress?fresh=1"), true);
  assert.equal(isLocalProgressPath("/api/local-progress/anything"), false);
  assert.equal(isLocalProgressPath("/api/local-progress.json"), false);

  for (const address of ["::1", "127.0.0.1", "127.8.9.10", "::ffff:127.0.0.1"]) {
    assert.equal(isLoopbackAddress(address), true, address);
  }
  for (const address of [undefined, "0.0.0.0", "192.168.1.2", "::ffff:192.168.1.2"]) {
    assert.equal(isLoopbackAddress(address), false, String(address));
  }

  for (const host of ["localhost", "localhost:3000", "127.0.0.1:3000", "[::1]:3000"]) {
    assert.equal(isLoopbackHost(host), true, host);
  }
  for (const host of [undefined, "evil.example", "192.168.1.2:3000"]) {
    assert.equal(isLoopbackHost(host), false, String(host));
  }
});

test("deployed local-progress route is a no-store capability-off response", async () => {
  const response = await productionGET();
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(await response.text(), "");
});
