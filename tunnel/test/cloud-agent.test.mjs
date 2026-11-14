import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { setupCommand } from "../src/codex-cloud.mjs";

async function fixture(t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "workssh-agent-test-"));
  const state = path.join(scratch, "state");
  const source = path.join(scratch, "repo/tunnel/src");
  await fs.mkdir(state, { mode: 0o700 });
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(path.join(state, "agent.json"), "{}", { mode: 0o600 });
  await fs.writeFile(path.join(state, "host_key.pub"), "ssh-ed25519 QUFBQQ== fixture-comment\n");
  // Real disposable processes model a supervisor and its child, not a cloud API.
  await fs.writeFile(path.join(source, "supervisor.mjs"), `
    import fs from 'node:fs';
    import { spawn } from 'node:child_process';
    const directory = ${JSON.stringify(scratch)};
    fs.writeFileSync(directory + '/supervisor-pid', String(process.pid));
    spawn(process.execPath, ['-e', "const fs = require('node:fs'), file = process.argv[1]; setInterval(() => { fs.writeFileSync(file + '.tmp', String(Date.now())); fs.renameSync(file + '.tmp', file); }, 30)", directory + '/child-pulse'], { stdio: 'ignore' });
    setInterval(() => { fs.writeFileSync(directory + '/pulse.tmp', String(Date.now())); fs.renameSync(directory + '/pulse.tmp', directory + '/pulse'); }, 30);
  `);
  const wrappers = [];
  t.after(async () => {
    // Every PID belongs to this fixture's detached timeout group.
    for (const pid of wrappers) {
      try { process.kill(-pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
    await fs.rm(scratch, { recursive: true, force: true });
  });
  function launch(deadline, expectedHostKey = "ssh-ed25519 QUFBQQ==") {
    const result = spawnSync("sh", ["-c", setupCommand({ scratch, pendingAgentDeadline: deadline, hostPublicKey: expectedHostKey }, true, {})], { encoding: "utf8", timeout: 5_000 });
    if (result.status !== 0) return { result };
    const report = JSON.parse(result.stdout.match(/^WORKSSH_AGENT=(.+)$/m)[1]);
    wrappers.push(report.wrapperPid);
    return { result, report };
  }
  return { scratch, state, source, launch, wrappers };
}

async function waitFor(file) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { return await fs.readFile(file, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
    await delay(20);
  }
  throw new Error(`Fixture process did not publish ${path.basename(file)}`);
}

test("the agent survives its launch command but its timeout terminates the entire process group", async (t) => {
  const { scratch, launch } = await fixture(t);
  const deadline = new Date(Date.now() + 2_500).toISOString();
  const { result, report } = launch(deadline);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(report.deadline, deadline);
  assert.equal(report.started, true);
  const pulse = path.join(scratch, "pulse"), childPulse = path.join(scratch, "child-pulse");
  const before = await waitFor(pulse), childBefore = await waitFor(childPulse);
  await delay(120);
  assert.notEqual(await fs.readFile(pulse, "utf8"), before, "supervisor must outlive the launcher process");
  assert.notEqual(await fs.readFile(childPulse, "utf8"), childBefore);
  await delay(Math.max(0, Date.parse(deadline) - Date.now()) + 250);
  const stopped = await fs.readFile(pulse, "utf8"), childStopped = await fs.readFile(childPulse, "utf8");
  await delay(120);
  assert.equal(await fs.readFile(pulse, "utf8"), stopped);
  assert.equal(await fs.readFile(childPulse, "utf8"), childStopped, "timeout must also terminate descendants");
});

test("recovery reuses the exact existing supervisor without extending its deadline or matching its caller", async (t) => {
  const { scratch, state, source, launch } = await fixture(t);
  const script = path.join(source, "supervisor.mjs"), config = path.join(state, "agent.json");
  const decoy = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", `${script} --config ${config}`], { stdio: "ignore" });
  await once(decoy, "spawn");
  t.after(async () => { const closed = once(decoy, "close"); decoy.kill(); await closed; });
  const deadline = new Date(Date.now() + 10_000).toISOString();
  const first = launch(deadline);
  assert.equal(first.result.status, 0, first.result.stderr);
  await waitFor(path.join(scratch, "supervisor-pid"));
  const second = launch(new Date(Date.now() + 60_000).toISOString(), "ssh-ed25519 QUFBQQ== different-comment");
  assert.equal(second.result.status, 0, second.result.stderr);
  assert.equal(second.report.started, false);
  assert.equal(second.report.wrapperPid, first.report.wrapperPid);
  assert.equal(second.report.deadline, deadline, "an already-running agent must not be renewed");
  assert.equal(second.report.hostPublicKey, "ssh-ed25519 QUFBQQ==");
});

test("changed host keys and elapsed deadlines prevent launch before any process is started", async (t) => {
  const { scratch, state, launch } = await fixture(t);
  const changed = launch(new Date(Date.now() + 10_000).toISOString(), "ssh-ed25519 QkJCQg==");
  assert.equal(changed.result.status, 1);
  assert.match(changed.result.stderr, /host key changed/i);
  const expired = launch(new Date(Date.now() - 1_000).toISOString());
  assert.equal(expired.result.status, 1);
  assert.match(expired.result.stderr, /deadline.*elapsed/i);
  await assert.rejects(fs.access(path.join(scratch, "supervisor-pid")), { code: "ENOENT" });
  await assert.rejects(fs.access(path.join(state, "agent-process.json")), { code: "ENOENT" });
});
