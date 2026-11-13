import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import WebSocket, { WebSocketServer } from "ws";
import { request, ApiError, CloudConnection, privateJson, readPrivateJson } from "../src/cloud-api.mjs";

const cli = fileURLToPath(new URL("../src/codex-cloud.mjs", import.meta.url));

async function httpServer(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

async function socketPair(t) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const incoming = once(server, "connection");
  const client = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
  await once(client, "open");
  const [peer] = await incoming;
  const connection = new CloudConnection(client);
  t.after(() => { connection.close(); peer.terminate(); server.close(); });
  return { connection, peer };
}

const item = (threadId, turnId, key) => ({ method: "item/completed", params: { threadId, turnId, item: { type: "agentMessage", text: `HOST_PUBLIC_KEY=ssh-ed25519 ${key}` } } });
const completed = (threadId, turnId) => ({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });

test("credentials are not forwarded across an HTTP redirect", async (t) => {
  let requests = 0;
  const base = await httpServer(t, (req, res) => {
    requests++;
    assert.equal(req.headers.authorization, "Bearer local-fixture");
    res.writeHead(302, { Location: "/different-origin-target" });
    res.end();
  });
  await assert.rejects(request(base, { Authorization: "Bearer local-fixture" }, "GET", "/redirect"), (error) => error instanceof ApiError && error.status === 302);
  assert.equal(requests, 1);
});

test("an uncertain creation is not retried after transport loss", async (t) => {
  let creations = 0;
  const base = await httpServer(t, (req) => { creations++; req.socket.destroy(); });
  await assert.rejects(request(base, {}, "POST", "/resources", { name: "disposable-fixture" }), /socket hang up/);
  assert.equal(creations, 1);
});

test("interleaved completed turns retain each independently reported host key", async (t) => {
  const { connection, peer } = await socketPair(t);
  peer.on("message", (raw) => {
    const message = JSON.parse(raw);
    peer.send(JSON.stringify(item("vm-a", "turn-a", "QUFBQQ==")));
    peer.send(JSON.stringify(item("vm-b", "turn-b", "QkJCQg==")));
    peer.send(JSON.stringify(completed("vm-b", "turn-b")));
    peer.send(JSON.stringify(completed("vm-a", "turn-a")));
    peer.send(JSON.stringify({ id: message.id, result: { accepted: true } }));
  });
  await connection.call("start-fixture", {});
  assert.equal((await connection.wait("vm-a", "turn-a")).hostPublicKey, "ssh-ed25519 QUFBQQ==");
  assert.equal((await connection.wait("vm-b", "turn-b")).hostPublicKey, "ssh-ed25519 QkJCQg==");
});

test("conflicting host keys fail pending observation and future calls", async (t) => {
  const { connection, peer } = await socketPair(t);
  const rejected = assert.rejects(connection.wait("vm-a", "turn-a"), /inconsistent host keys/);
  peer.send(JSON.stringify(item("vm-a", "turn-a", "QUFBQQ==")));
  peer.send(JSON.stringify(item("vm-a", "turn-a", "QkJCQg==")));
  await rejected;
  await assert.rejects(connection.call("start-fixture", {}), /inconsistent host keys/);
  await assert.rejects(connection.wait("vm-a", "turn-a"), /inconsistent host keys/);
});

test("a disconnected observation fails instead of waiting for a new event", async (t) => {
  const { connection, peer } = await socketPair(t);
  const closed = once(connection.socket, "close");
  peer.close();
  await closed;
  await assert.rejects(connection.wait("vm-a", "turn-a"), /connection closed/);
});

test("a server approval request cannot masquerade as a pending RPC response", async (t) => {
  const { connection, peer } = await socketPair(t);
  const reply = new Promise((resolve) => peer.on("message", (raw) => {
    const message = JSON.parse(raw);
    if (message.error) resolve(message);
    else peer.send(JSON.stringify({ id: message.id, method: "item/commandExecution/requestApproval", params: {} }));
  }));
  await assert.rejects(connection.call("start-fixture", {}), /No approval was granted/);
  assert.equal((await reply).error.code, -32601);
});

test("replacing session state preserves private permissions and rejects exposed files", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "workssh-state-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "session.json");
  privateJson(file, { phase: "creating", ids: [] });
  privateJson(file, { phase: "ready", ids: ["owned-vm"] });
  assert.deepEqual(readPrivateJson(file), { phase: "ready", ids: ["owned-vm"] });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(directory), ["session.json"]);
  fs.chmodSync(file, 0o644);
  assert.throws(() => readPrivateJson(file), /private regular file/);
});

test("dry-run and rejected usage leave the selected state path untouched", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "workssh-cli-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const statePath = path.join(directory, "new-session");
  const args = ["--state-dir", statePath, "--auth-file", path.join(directory, "missing-auth")];
  const dry = spawnSync(process.execPath, [cli, "up", "--dry-run", "--count", "2", ...args], { encoding: "utf8" });
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(JSON.parse(dry.stdout).count, 2);
  assert.equal(fs.existsSync(statePath), false);
  for (const command of [["up", "--count", "9"], ["down"], ["verify", "--hold-seconds", "0"]]) {
    const rejected = spawnSync(process.execPath, [cli, ...command, ...args], { encoding: "utf8" });
    assert.equal(rejected.status, 2, rejected.stderr);
    assert.equal(fs.existsSync(statePath), false);
  }
  const forwarded = spawnSync(process.execPath, [cli, "ssh", ...args, "--", "uname", "--version"], { encoding: "utf8" });
  assert.equal(forwarded.status, 1, forwarded.stderr);
  assert.match(forwarded.stderr, /ENOENT/);
});

test("partially deleted sessions cannot resume model work or open new SSH sessions", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "workssh-deleting-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  privateJson(path.join(directory, "session.json"), { version: 1, phase: "deleting", count: 1, vms: [] });
  for (const command of ["resume", "ssh", "verify"]) {
    const rejected = spawnSync(process.execPath, [cli, command, "--state-dir", directory, "--auth-file", path.join(directory, "missing-auth")], { encoding: "utf8" });
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /Session teardown has started/);
    assert.equal(fs.existsSync(path.join(directory, ".lock")), false);
  }
});
