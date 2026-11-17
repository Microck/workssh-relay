import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { ApiError, privateJson, readPrivateJson, request } from "../src/cloud-api.mjs";
import { confirmRuntimeOffline, deleteRelay } from "../src/codex-cloud.mjs";

async function fixture(t, mode) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "workssh-cleanup-test-"));
  const journal = path.join(directory, "session.json");
  const session = { cloudflareAccountId: "fixture-account", workerName: "fixture-worker", workerOwned: true, workerDeleted: false, closed: false };
  const observations = { deletes: 0, namespaceReads: 0, pages: [], workerExists: true, runtimeReads: 0 };
  const namespaceId = "fixture-namespace";
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://fixture.invalid");
    const reply = (status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.method === "GET" && url.pathname === "/runtime/status") {
      observations.runtimeReads++;
      if (mode === "runtime-hanging") return;
      observations.runtimeStatus = observations.runtimeReads <= 21 ? "connected" : "offline";
      return reply(200, { status: observations.runtimeStatus });
    }
    if (req.method === "DELETE" && url.pathname.endsWith("/workers/scripts/fixture-worker")) {
      observations.deletes++;
      observations.workerExists = false;
      reply(200, { success: true });
    } else if (req.method === "GET" && url.pathname.endsWith("/fixture-worker/settings")) {
      reply(observations.workerExists ? 200 : 404, observations.workerExists
        ? { success: true, result: { bindings: [{ name: "TUNNELS", namespace_id: namespaceId }] } }
        : { success: false, errors: [{ message: "Worker absent" }] });
    } else if (req.method === "GET" && url.pathname.endsWith("/durable_objects/namespaces")) {
      observations.namespaceReads++;
      const page = Number(url.searchParams.get("page") ?? 1);
      observations.pages.push(page);
      if (mode === "denied") return reply(403, { success: false, errors: [{ message: "Access denied" }] });
      if (mode === "hanging") return;
      if (mode === "malformed") return reply(200, { success: true });
      if (mode === "paginated" && page === 1) {
        return reply(200, { success: true, result: Array.from({ length: 1000 }, (_, index) => ({ id: `other-${index}` })), result_info: { page, per_page: 1000, count: 1000, total_count: 1001 } });
      }
      const present = mode === "timeout" || mode === "paginated" && observations.namespaceReads <= 2 || mode === "lagging" && observations.namespaceReads <= 3;
      reply(200, { success: true, result: present ? [{ id: namespaceId }] : [], result_info: { page, per_page: 1000, count: present ? 1 : 0 } });
    } else reply(400, { success: false, errors: [{ message: "Unexpected fixture operation" }] });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const control = {
    request: async (method, endpoint, body, contentType, signal) => {
      const response = await request(base, {}, method, endpoint, body, contentType, signal);
      if (response.success === false) throw new Error("Fixture API rejected operation");
      return response;
    },
    save: () => privateJson(journal, session),
  };
  control.save();
  return { session, observations, control, journal, namespaceId };
}

test("relay cleanup confirms eventual namespace disappearance after one Worker deletion", async t => {
  const p = await fixture(t, "lagging");
  await deleteRelay(p.session, p.control, { timeoutMs: 1000, pollMs: 5 });
  assert.equal(p.session.workerDeleted, true);
  assert.equal(p.observations.deletes, 1, "only confirmation reads may repeat");
  assert.equal(p.observations.namespaceReads, 4);
  assert.equal(readPrivateJson(p.journal).namespaceId, p.namespaceId, "persist ownership before Worker deletion");
});

test("a still-visible namespace times out without marking cleanup complete or losing its journal", async t => {
  const p = await fixture(t, "timeout");
  await assert.rejects(deleteRelay(p.session, p.control, { timeoutMs: 80, pollMs: 5 }), /namespace deletion not confirmed.*80ms/i);
  assert.equal(p.session.workerDeleted, false);
  assert.equal(p.session.closed, false);
  assert.equal(p.observations.deletes, 1);
  assert.equal(readPrivateJson(p.journal).namespaceId, p.namespaceId);
  assert.equal(readPrivateJson(p.journal).workerDeleted, false);
});

test("namespace authorization failures stop immediately without retrying DELETE or GET", async t => {
  const p = await fixture(t, "denied");
  await assert.rejects(deleteRelay(p.session, p.control, { timeoutMs: 1000, pollMs: 5 }), error => error instanceof ApiError && error.status === 403);
  assert.equal(p.session.workerDeleted, false);
  assert.equal(p.observations.deletes, 1);
  assert.equal(p.observations.namespaceReads, 1);
});

test("namespace confirmation includes later pages rather than accepting absence on page one", async t => {
  const p = await fixture(t, "paginated");
  await deleteRelay(p.session, p.control, { timeoutMs: 1000, pollMs: 5 });
  assert.equal(p.session.workerDeleted, true);
  assert.deepEqual(p.observations.pages, [1, 2, 1, 2]);
  assert.equal(p.observations.deletes, 1);
});

test("the namespace deadline aborts an in-flight HTTP read and retains incomplete state", async t => {
  const p = await fixture(t, "hanging");
  const started = performance.now();
  await assert.rejects(deleteRelay(p.session, p.control, { timeoutMs: 80, pollMs: 5 }), /namespace deletion not confirmed.*80ms/i);
  assert.ok(performance.now() - started < 2000, "must not wait for the generic 45-second HTTP timeout");
  assert.equal(p.session.workerDeleted, false);
  assert.equal(p.observations.deletes, 1);
  assert.equal(p.observations.namespaceReads, 1);
});

test("a malformed successful list response is not deletion evidence", async t => {
  const p = await fixture(t, "malformed");
  await assert.rejects(deleteRelay(p.session, p.control, { timeoutMs: 1000, pollMs: 5 }), /namespace listing/i);
  assert.equal(p.session.workerDeleted, false);
  assert.equal(p.observations.namespaceReads, 1);
});

test("runtime shutdown confirmation tolerates a provider still connected after twenty observations", async t => {
  const p = await fixture(t, "runtime-lagging");
  await confirmRuntimeOffline(signal => p.control.request("GET", "/runtime/status", undefined, undefined, signal), { timeoutMs: 1000, pollMs: 5 });
  assert.equal(p.observations.runtimeStatus, "offline");
});

test("runtime shutdown confirmation bounds an in-flight status read without assuming offline", async t => {
  const p = await fixture(t, "runtime-hanging");
  const started = performance.now();
  await assert.rejects(confirmRuntimeOffline(signal => p.control.request("GET", "/runtime/status", undefined, undefined, signal), { timeoutMs: 80, pollMs: 5 }), /runtime shutdown not confirmed.*80ms/i);
  assert.ok(performance.now() - started < 2000);
  assert.equal(p.observations.runtimeReads, 1);
});
