import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { createLocalAtlasMiddleware } from "../build/local-atlas-vite-plugin.ts";

async function serveRuntime(options = {}) {
  const runtime = createLocalAtlasMiddleware(options);
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
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    runtime,
    async close() {
      runtime.close();
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

test("supervised shutdown is local, authenticated, bodyless, and scheduled once after its response", async (context) => {
  let responseConsumed = false;
  const callbackObservations = [];
  const app = await serveRuntime({
    shutdownApplication() {
      callbackObservations.push(responseConsumed);
    },
  });
  context.after(() => app.close());

  const statusResponse = await fetch(`${app.baseUrl}/api/local-atlas/status`);
  assert.equal(statusResponse.status, 200);
  const status = await statusResponse.json();
  assert.equal(status.shutdownAvailable, true);
  assert.equal("supervisorPid" in status, false);
  assert.equal("launcherPath" in status, false);

  for (const method of ["GET", "PUT", "DELETE"]) {
    const response = await fetch(`${app.baseUrl}/api/local-atlas/shutdown`, {
      method,
      headers: { "X-Atlas-Token": status.mutationToken },
    });
    assert.equal(response.status, 405, method);
  }
  assert.equal(callbackObservations.length, 0);

  const foreignOrigin = await fetch(
    `${app.baseUrl}/api/local-atlas/shutdown`,
    {
      method: "POST",
      headers: {
        Origin: "https://evil.example",
        "X-Atlas-Token": status.mutationToken,
      },
    },
  );
  assert.equal(foreignOrigin.status, 403);

  const missingToken = await fetch(
    `${app.baseUrl}/api/local-atlas/shutdown`,
    { method: "POST" },
  );
  assert.equal(missingToken.status, 403);
  const wrongToken = await fetch(
    `${app.baseUrl}/api/local-atlas/shutdown`,
    {
      method: "POST",
      headers: { "X-Atlas-Token": "not-the-runtime-token" },
    },
  );
  assert.equal(wrongToken.status, 403);

  const queryInjection = await fetch(
    `${app.baseUrl}/api/local-atlas/shutdown?command=killall`,
    {
      method: "POST",
      headers: { "X-Atlas-Token": status.mutationToken },
    },
  );
  assert.equal(queryInjection.status, 400);
  const bodyInjection = await fetch(
    `${app.baseUrl}/api/local-atlas/shutdown`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Atlas-Token": status.mutationToken,
      },
      body: JSON.stringify({ pid: 1, path: "/tmp", command: "killall" }),
    },
  );
  assert.equal(bodyInjection.status, 400);

  const regionalStop = await fetch(`${app.baseUrl}/api/local-atlas/stop`, {
    method: "POST",
    headers: { "X-Atlas-Token": status.mutationToken },
  });
  assert.equal(regionalStop.status, 409);
  assert.equal(callbackObservations.length, 0);

  const shutdownResponse = await fetch(
    `${app.baseUrl}/api/local-atlas/shutdown`,
    {
      method: "POST",
      headers: { "X-Atlas-Token": status.mutationToken },
    },
  );
  assert.equal(shutdownResponse.status, 202);
  assert.equal(shutdownResponse.headers.get("cache-control"), "no-store");
  assert.deepEqual(await shutdownResponse.json(), { shuttingDown: true });
  responseConsumed = true;
  assert.equal(callbackObservations.length, 0);

  const duplicate = await fetch(`${app.baseUrl}/api/local-atlas/shutdown`, {
    method: "POST",
    headers: { "X-Atlas-Token": status.mutationToken },
  });
  assert.equal(duplicate.status, 202);
  assert.deepEqual(await duplicate.json(), { shuttingDown: true });

  await delay(400);
  assert.deepEqual(callbackObservations, [true]);
});

test("an unsupervised runtime advertises no shutdown capability", async (context) => {
  const app = await serveRuntime();
  context.after(() => app.close());
  const status = await (
    await fetch(`${app.baseUrl}/api/local-atlas/status`)
  ).json();
  assert.equal(status.shutdownAvailable, false);

  const response = await fetch(`${app.baseUrl}/api/local-atlas/shutdown`, {
    method: "POST",
    headers: { "X-Atlas-Token": status.mutationToken },
  });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /aplicación supervisada/);
});

test("default shutdown invokes only the source launcher with the expected supervisor", async (context) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "atlas-shutdown-source-"));
  const argumentsPath = join(projectRoot, "shutdown-arguments.txt");
  await writeFile(
    join(projectRoot, "start_local_atlas_luisa.sh"),
    `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "$(dirname "$0")/shutdown-arguments.txt"\n`,
    "utf8",
  );
  const app = await serveRuntime({ projectRoot, supervisorPid: 42_424 });
  context.after(async () => {
    await app.close();
    await rm(projectRoot, { recursive: true, force: true });
  });

  const status = await (
    await fetch(`${app.baseUrl}/api/local-atlas/status`)
  ).json();
  assert.equal(status.shutdownAvailable, true);
  const response = await fetch(`${app.baseUrl}/api/local-atlas/shutdown`, {
    method: "POST",
    headers: { "X-Atlas-Token": status.mutationToken },
  });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { shuttingDown: true });

  let argumentsText = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await delay(50);
    argumentsText = await readFile(argumentsPath, "utf8").catch(() => null);
    if (argumentsText !== null) break;
  }
  assert.equal(
    argumentsText,
    "--stop\n--expected-supervisor-pid\n42424\n",
  );
});

test("a scheduler failure unlocks one safe shutdown retry", async (context) => {
  let attempts = 0;
  const app = await serveRuntime({
    shutdownApplication() {
      attempts += 1;
      if (attempts === 1) throw new Error("spawn failed");
    },
  });
  context.after(() => app.close());
  const status = await (
    await fetch(`${app.baseUrl}/api/local-atlas/status`)
  ).json();
  const requestShutdown = () =>
    fetch(`${app.baseUrl}/api/local-atlas/shutdown`, {
      method: "POST",
      headers: { "X-Atlas-Token": status.mutationToken },
    });

  assert.equal((await requestShutdown()).status, 202);
  await delay(350);
  assert.equal(attempts, 1);
  assert.equal((await requestShutdown()).status, 202);
  await delay(350);
  assert.equal(attempts, 2);
});
