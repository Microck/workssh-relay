import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { keepaliveSession } from "../src/codex-cloud.mjs";
import { privateJson } from "../src/cloud-api.mjs";

const cli = fileURLToPath(new URL("../src/codex-cloud.mjs", import.meta.url));
const fixture = () => ({
  version: 1, id: "session", cloudAccount: "account", configId: "config", phase: "ready", count: 2,
  vms: [1, 2].map((index) => ({
    index, threadId: `thread-${index}`, runtimeId: `runtime-${index}`, turnId: `setup-${index}`,
    hostPublicKey: "ssh-ed25519 QUFBQQ==", readyAt: "2026-01-01T00:00:00Z", agentDeadline: "2999-01-01T00:00:00Z",
  })),
});

// A stateful control-plane fake, not a module replacement. Only native resume is
// accepted; any model, setup, or allocation method fails the test immediately.
function plane(session = fixture()) {
  const saved = structuredClone(session);
  const calls = [];
  const turns = new Map(saved.vms.map((vm) => [vm.threadId, [{ id: `latest-${vm.index}`, status: "completed" }]]));
  const statuses = new Map(saved.vms.map((vm) => [vm.runtimeId, "connected"]));
  const pins = new Map(saved.vms.map((vm) => [vm.index, `workssh.invalid ${vm.hostPublicKey}\n`]));
  const rpc = {
    async call(method, params) {
      calls.push({ method, params });
      assert.equal(method, "thread/resume");
      assert.deepEqual(params, { threadId: params.threadId, excludeTurns: true });
      const vm = saved.vms.find((candidate) => candidate.threadId === params.threadId);
      return { thread: { id: vm.threadId, environments: [{ environmentId: vm.runtimeId, environmentConfigId: saved.configId }] } };
    },
  };
  const control = {
    readSession: () => structuredClone(saved),
    readHostPin: (vm) => pins.get(vm.index),
    readLatestTurns: (vm) => structuredClone(turns.get(vm.threadId)),
    readRuntime: (vm) => ({ status: statuses.get(vm.runtimeId) }),
    call: (method, params) => rpc.call(method, params),
  };
  return { session, saved, calls, turns, statuses, pins, control };
}

test("keepalive resumes each exact native thread once without a model turn or SSH claim", async () => {
  const p = plane();
  const original = structuredClone(p.saved);
  const result = await keepaliveSession(p.session, p.control);
  assert.deepEqual(result, {
    phase: "ready", count: 2, resumed: true,
    vms: [1, 2].map((index) => ({
      index, threadId: `thread-${index}`, runtimeId: `runtime-${index}`, status: "connected",
      latestTurnId: `latest-${index}`, latestTurnStatus: "completed", latestTurnUnchanged: true,
    })),
  });
  assert.deepEqual(p.calls.map((call) => call.params.threadId), ["thread-1", "thread-2"]);
  assert.deepEqual(p.saved, original);
  assert.deepEqual(p.session, original);
});

for (const [label, change] of [
  ["teardown", (s) => { s.phase = "deleting"; }],
  ["deleted vault", (s) => { s.vaultDeleted = true; }],
  ["expired access", (s) => { s.vms[0].agentDeadline = "2000-01-01T00:00:00Z"; }],
  ["missing deadline", (s) => { delete s.vms[0].agentDeadline; }],
  ["incomplete setup", (s) => { s.vms[0].setupPending = true; }],
  ["uncertain allocation", (s) => { s.vms[0].allocationRecovered = true; }],
  ["ambiguous runtime", (s) => { s.vms[1].runtimeId = s.vms[0].runtimeId; }],
  ["ambiguous thread", (s) => { s.vms[1].threadId = s.vms[0].threadId; }],
  ["missing ownership", (s) => { delete s.cloudAccount; }],
  ["unassigned discovery", (s) => { s.discoveredRuntimes = ["orphan-runtime"]; }],
]) test(`keepalive refuses ${label} before issuing resume`, async () => {
  const session = fixture();
  change(session);
  const p = plane(session);
  await assert.rejects(keepaliveSession(session, p.control), /Keepalive refused/);
  assert.deepEqual(p.calls, []);
});

for (const status of ["inProgress", "failed", "interrupted"]) test(`keepalive refuses latest turn ${status} across all targets before resume`, async () => {
  const p = plane();
  p.turns.get("thread-2")[0].status = status;
  await assert.rejects(keepaliveSession(p.session, p.control), /latest turn/);
  assert.deepEqual(p.calls, []);
});

test("keepalive refuses an offline target before resuming any VM", async () => {
  const p = plane();
  p.statuses.set("runtime-2", "offline");
  await assert.rejects(keepaliveSession(p.session, p.control), /not connected/);
  assert.deepEqual(p.calls, []);
});

test("keepalive refuses a turn or local identity changed during preflight", async () => {
  for (const change of [
    (p) => { p.turns.get("thread-1")[0].id = "new-turn"; },
    (p) => { p.saved.vms[0].agentDeadline = "2000-01-01T00:00:00Z"; },
  ]) {
    const p = plane();
    const read = p.control.readLatestTurns;
    p.control.readLatestTurns = (vm) => {
      const turns = read(vm);
      if (vm.index === 2) change(p);
      return turns;
    };
    await assert.rejects(keepaliveSession(p.session, p.control), /Keepalive refused/);
    assert.deepEqual(p.calls, []);
  }
});

test("keepalive accepts an absent optional returned config association", async () => {
  const p = plane();
  const native = p.control.call;
  p.control.call = async (method, params) => {
    const reply = await native(method, params);
    delete reply.thread.environments[0].environmentConfigId;
    return reply;
  };
  assert.deepEqual((await keepaliveSession(p.session, p.control)).vms.map((vm) => vm.runtimeId), ["runtime-1", "runtime-2"]);
});

for (const [label, change] of [
  ["runtime", (reply) => { reply.thread.environments[0].environmentId = "replacement"; }],
  ["thread", (reply) => { reply.thread.id = "replacement"; }],
  ["config", (reply) => { reply.thread.environments[0].environmentConfigId = "replacement"; }],
  ["ambiguous environment", (reply) => { reply.thread.environments.push(reply.thread.environments[0]); }],
]) test(`keepalive rejects changed ${label} without a second resume`, async () => {
  const p = plane();
  const native = p.control.call;
  p.control.call = async (method, params) => {
    const reply = await native(method, params);
    change(reply);
    return reply;
  };
  await assert.rejects(keepaliveSession(p.session, p.control), /identity changed/);
  assert.equal(p.calls.length, 1);
});

for (const [label, change] of [
  ["turn ID", (p) => { p.turns.get("thread-1")[0].id = "new-turn"; }],
  ["turn status", (p) => { p.turns.get("thread-1")[0].status = "inProgress"; }],
  ["offline runtime", (p) => { p.statuses.set("runtime-1", "offline"); }],
  ["session identity", (p) => { p.saved.id = "replacement"; }],
  ["canonical pin", (p) => { p.saved.vms[0].hostPublicKey = "ssh-ed25519 QkJCQg=="; }],
  ["local pin file", (p) => { p.pins.set(1, "workssh.invalid ssh-ed25519 QkJCQg==\n"); }],
  ["elapsed deadline", (p) => { p.saved.vms[0].agentDeadline = "2000-01-01T00:00:00Z"; }],
]) test(`keepalive stops after resume changes ${label}`, async () => {
  const p = plane();
  const native = p.control.call;
  p.control.call = async (method, params) => {
    const reply = await native(method, params);
    change(p);
    return reply;
  };
  await assert.rejects(keepaliveSession(p.session, p.control), /Keepalive refused/);
  assert.equal(p.calls.length, 1);
});

for (const stage of ["readLatestTurns", "readRuntime", "call"]) {
  for (const reason of ["denied", "timed out", "connection lost"]) test(`keepalive does not retry ${stage} on ${reason} or print payloads`, async () => {
    const p = plane();
    let attempts = 0;
    p.control[stage] = async () => { attempts++; throw new Error(`secret-provider-payload ${reason}`); };
    await assert.rejects(keepaliveSession(p.session, p.control), (error) => {
      assert.match(error.message, /failed/);
      assert.doesNotMatch(error.message, /secret-provider-payload/);
      return true;
    });
    assert.equal(attempts, 1);
    assert.deepEqual(p.calls, []);
  });
}

test("keepalive CLI refuses teardown and duration/credit options without credentials or API access", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "workssh-keepalive-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  privateJson(path.join(directory, "session.json"), { version: 1, phase: "deleting", count: 1, vms: [] });
  const args = [cli, "keepalive", "--state-dir", directory, "--auth-file", path.join(directory, "missing-auth")];
  const teardown = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(teardown.status, 1);
  assert.match(teardown.stderr, /Session teardown has started/);
  assert.equal(fs.existsSync(path.join(directory, ".lock")), false);
  for (const extra of [["--allow-credits"], ["--lifetime-minutes", "20"], ["--agent-deadline", "1"]]) {
    const rejected = spawnSync(process.execPath, [...args, ...extra], { encoding: "utf8" });
    assert.equal(rejected.status, 2);
    assert.doesNotMatch(rejected.stderr, /ENOENT/);
  }
});
