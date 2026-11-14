#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { ApiError, CLOUD, RUNTIMES, CLOUDFLARE, request, privateJson, readPrivateJson, cloudCredentials, cloudflareCredentials, redact, CloudConnection } from "./cloud-api.mjs";
import { agentLaunchCommand, canonicalHostKey } from "./cloud-agent.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const repoUrl = "https://github.com/catoncat/workssh-relay.git";
const repositoryId = "github-1309557189"; // Public upstream checkout for the disposable environment.
// Keep cloud installation on the reviewed agent sources, not a moving branch.
const agentRevision = "365a039d59b7d25d3f9e5d8770af61b226355fdd";
const help = `WorkSSH Codex Cloud

  npm run cloud -- up --state-dir PATH --count 1
  npm run cloud -- verify --state-dir PATH
  npm run cloud -- ssh --state-dir PATH --vm 1 -- uname -a
  npm run cloud -- down --state-dir PATH --yes

Commands: up, resume, status, ssh, verify, down
Options:
  --state-dir PATH          Private session directory; required except for dry-run
  --count N                 Independent VMs, 1..8 (default 1)
  --lifetime-minutes N      Access window for up/resume, 1..43200 (default 20 at up)
  --agent-deadline MS       Absolute Unix-ms access deadline, instead of minutes
  --hold-seconds N          Verify overlap, 1..120 (default 20)
  --vm N                    VM index for ssh (default 1)
  --model ID                Setup model (default gpt-6-luna); no fallback
  --auth-file PATH          Default ~/.codex/auth.json; read only
  --cloudflare-env PATH     Private Cloudflare credentials file
  --account-id ID           Select a Cloudflare account
  --allow-credits           Permit existing Codex credits if allowance is exhausted
  --dry-run                 up only; print plan without credentials or side effects
  --yes                     Required for down, deletes this session's resources
  --json                    Machine-readable stdout; progress goes to stderr
  -h, --help                Show help without credentials
  --version                 Print version

No purchases or subscription changes. Up to eight was tested, not a platform maximum.
See docs/codex-cloud.md.\n`;

class UsageError extends Error {}
function number(value, name, min, max) {
  if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) throw new UsageError(`${name} must be an integer from ${min} to ${max}`);
  return Number(value);
}
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const segment = encodeURIComponent;
const progress = (message) => console.error(message);
const secrets = [];
let connection;
let interrupted = false;
let state;
let directory;
let options;
let cloudHeaders;
let agentDeadline;
let cf;

function save() { privateJson(path.join(directory, "session.json"), state); }
function checkInterrupted() { if (interrupted) throw new Error("Interrupted. Saved state retained; use status or down before retrying"); }
const cloud = (method, endpoint, body) => request(CLOUD, cloudHeaders, method, endpoint, body);
async function cloudflare(method, endpoint, body, contentType) {
  const response = await request(CLOUDFLARE, cf.headers, method, endpoint, body, contentType);
  if (response.success === false) throw new Error(`Cloudflare rejected ${method} ${endpoint}: ${JSON.stringify(response.errors)}`);
  return response;
}
async function rpc() { connection ??= await CloudConnection.open(cloudHeaders); return connection; }

async function pages(endpoint, field, cursorField) {
  const rows = [];
  const seen = new Set();
  let cursor;
  do {
    const separator = endpoint.includes("?") ? "&" : "?";
    const page = await cloud("GET", `${endpoint}${cursor ? `${separator}cursor=${segment(cursor)}` : ""}`);
    rows.push(...(page[field] ?? []));
    cursor = page[cursorField];
    if (cursor && seen.has(cursor)) throw new Error("Cloud pagination repeated a cursor");
    seen.add(cursor);
  } while (cursor);
  return rows;
}

function run(command, args, extra = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, ...extra });
    let output = "";
    child.stdout?.on("data", (chunk) => { output += chunk; });
    child.stderr?.on("data", (chunk) => { output += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => code === 0 ? resolve(output) : reject(new Error(`${command} ${signal ?? `exited ${code}`}: ${output.slice(-3000)}`)));
  });
}

async function consent() {
  const rate = await cloud("GET", "/v2/account/rate-limits");
  if (rate.ordinaryUsageAllowed === false || !rate.rateLimits) throw new Error("Account usage is unavailable or disallowed; inspect Codex usage before starting a task");
  const limit = rate.rateLimits;
  if ((limit.rateLimitReachedType || limit.primary?.usedPercent >= 100 || limit.secondary?.usedPercent >= 100) && !options["allow-credits"]) {
    throw new Error("Included Codex allowance is exhausted. Use --allow-credits to consent to existing credits; no purchases will be made");
  }
  if (limit?.credits?.balance !== undefined) state.lastCreditBalance = limit.credits.balance;
  const models = await (await rpc()).call("model/list", {});
  const model = models.data.find((m) => m.model === state.model);
  if (!model || !model.supportedReasoningEfforts.some((e) => e.reasoningEffort === "medium")) throw new Error(`Setup model ${state.model} with medium reasoning is unavailable; refusing model fallback`);
}

async function buildRelay() {
  const binary = path.join(root, "relay/node_modules/.bin/wrangler");
  if (!fs.existsSync(binary)) throw new Error("Install the locked dependencies: npm --prefix relay ci && npm --prefix tunnel ci");
  const out = path.join(directory, "bundle");
  await run(binary, ["deploy", "--dry-run", "--outdir", out], {
    cwd: path.join(root, "relay"), env: { ...process.env, XDG_CONFIG_HOME: path.join(directory, "build-config"), CLOUDFLARE_SEND_METRICS: "false" },
  });
  return fs.readFileSync(path.join(out, "index.js"));
}

async function deployRelay(code) {
  state.cloudflareAccountId = options["account-id"] ?? cf.accountId;
  if (!state.cloudflareAccountId) {
    const accounts = (await cloudflare("GET", "/accounts")).result;
    if (accounts.length !== 1) throw new Error("Select a Cloudflare account with --account-id");
    state.cloudflareAccountId = accounts[0].id;
  }
  save();
  const endpoint = workerPath();
  try {
    await cloudflare("GET", `${endpoint}/settings`);
    throw new Error(`Worker ${state.workerName} already exists; refusing to overwrite it`);
  } catch (error) { if (!(error instanceof ApiError && error.status === 404)) throw error; }
  // Record ownership intent before upload. A timeout must not cause another PUT.
  state.workerOwned = true;
  save();
  const form = new FormData();
  const config = JSON.parse(fs.readFileSync(path.join(root, "relay/wrangler.jsonc"), "utf8"));
  form.append("metadata", JSON.stringify({
    main_module: "index.js", compatibility_date: config.compatibility_date,
    bindings: [{ type: "durable_object_namespace", name: "TUNNELS", class_name: "TunnelRoom" }, { type: "secret_text", name: "RELAY_TOKEN", text: state.relayToken }],
    exports: { TunnelRoom: { type: "durable-object", storage: "sqlite" } },
  }));
  form.append("index.js", new Blob([code], { type: "application/javascript+module" }), "index.js");
  const encoded = new Request("https://localhost/", { method: "PUT", body: form });
  await cloudflare("PUT", endpoint, Buffer.from(await encoded.arrayBuffer()), encoded.headers.get("content-type"));
  const subdomain = (await cloudflare("GET", `/accounts/${segment(state.cloudflareAccountId)}/workers/subdomain`)).result.subdomain;
  state.workerUrl = `https://${state.workerName}.${subdomain}.workers.dev`;
  save();
  await cloudflare("POST", `${endpoint}/subdomain`, { enabled: true, previews_enabled: false });
  // Routing can lag upload. Retry only a read, and only its observed transient 404.
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      const health = await request(state.workerUrl, {}, "GET", "/health");
      if (health.service !== "workssh-relay" || health.protocol !== 1) throw new Error("Unexpected relay health response");
      return;
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 404) || attempt === 11) throw error;
      await delay(1000);
    }
  }
}

function workerPath() { return `/accounts/${segment(state.cloudflareAccountId)}/workers/scripts/${segment(state.workerName)}`; }

async function up(count) {
  await consent();
  state.initialCreditBalance = state.lastCreditBalance;
  save();
  const code = await buildRelay();
  await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", path.join(directory, "client_key")]);
  state.publicKey = fs.readFileSync(path.join(directory, "client_key.pub"), "utf8").trim();
  save();
  await deployRelay(code);
  checkInterrupted();
  state.configPending = true;
  save();
  const config = await cloud("POST", "/v1/environment-configs", {
    name: state.configName, repositories: [{ repository_id: repositoryId, ref: "main" }],
    network_policy: { type: "unrestricted" }, share_settings: "private", start_onboarding: false,
    runtime_requirements: [{ source: { type: "user_provided" }, optional: false, delivery: { type: "direct_environment_variable", variable_name: state.variableName } }],
  });
  state.configId = config.id;
  state.configPending = false;
  save();
  const readback = await cloud("GET", `/v1/environment-configs/${segment(state.configId)}`);
  if (!readback.runtime_requirements?.some((r) => r.delivery?.variable_name === state.variableName)) throw new Error("Initial published config did not retain the secure variable requirement");
  checkInterrupted();
  state.vaultPending = true;
  save();
  const vault = await cloud("POST", "/v1/personal-secrets", {
    namespace: "not_sensitive", secrets: [{ name: state.variableName, env_var: state.variableName, value: state.relayToken, target: { type: "environment_config_ids", ids: [state.configId] } }],
  });
  state.vaultId = vault.secrets[0].id;
  state.vaultPending = false;
  save();
  const socket = await rpc();
  for (let index = 1; index <= count; index++) {
    checkInterrupted();
    const vm = { index, tunnelId: crypto.randomBytes(16).toString("hex"), scratch: `/tmp/workssh-${state.id}-${index}`, allocationPending: true };
    state.vms.push(vm);
    save();
    const allocated = await socket.call("thread/start", {
      serviceName: "codex_cloud", model: state.model, allowProviderModelFallback: false, threadSource: "user", environments: [{ environmentConfigId: state.configId }], deferredEnvironment: false, pluginsMcp: { productSku: "codex" },
      approvalPolicy: "on-request", approvalsReviewer: "auto_review",
    });
    vm.threadId = allocated.thread.id;
    vm.runtimeId = allocated.thread.environments[0].environmentId;
    vm.allocationPending = false;
    save();
    if (allocated.approvalPolicy !== "on-request" || allocated.approvalsReviewer !== "auto_review") throw new Error("Cloud did not enable the requested per-task command reviewer; no setup task was started");
    await startSetup(vm, false);
  }
  await Promise.all(state.vms.map(finishSetup));
  state.phase = "ready";
  save();
  return summary(true);
}

export function setupCommand(vm, restarting, session = state) {
  const launch = agentLaunchCommand({ scratch: vm.scratch, deadline: vm.pendingAgentDeadline, ...(restarting ? { expectedHostKey: canonicalHostKey(vm.hostPublicKey) } : {}) });
  const installation = restarting ? [] : [
    `if [ -n "\${${session.variableName}:-}" ]; then printf 'vault_var_present=true\\n'; else printf 'vault_var_present=false\\n'; exit 1; fi`,
    `export WORKSSH_RELAY_TOKEN="\${${session.variableName}}"`,
    `export WORKSSH_WORKER_URL=${quote(session.workerUrl)} WORKSSH_TUNNEL_ID=${quote(vm.tunnelId)} WORKSSH_PUBLIC_KEY=${quote(session.publicKey)} WORKSSH_STATE_DIR=${quote(`${vm.scratch}/state`)}`,
    `mkdir -p ${quote(vm.scratch)}`,
    `export npm_config_cache=${quote(`${vm.scratch}/npm-cache`)} npm_config_userconfig=${quote(`${vm.scratch}/npm-user`)} npm_config_globalconfig=${quote(`${vm.scratch}/npm-global`)}`,
    `touch "$npm_config_userconfig" "$npm_config_globalconfig"`,
    `curl --fail --silent --show-error "$WORKSSH_WORKER_URL/health"`,
    `git clone --quiet ${quote(repoUrl)} ${quote(`${vm.scratch}/repo`)}`,
    `git -C ${quote(`${vm.scratch}/repo`)} checkout --quiet ${agentRevision}`,
    `bash ${quote(`${vm.scratch}/repo/scripts/install-agent.sh`)}`,
  ];
  const script = ["set -euo pipefail", ...installation, launch, "hostname"].join("\n");
  const seconds = Math.max(1, Math.floor((Date.parse(vm.pendingAgentDeadline) - Date.now()) / 1000));
  return `timeout --signal=TERM --kill-after=5s ${seconds}s bash <<'WORKSSH_SETUP'\n${script}\nWORKSSH_SETUP`;
}

export function setupPrompt(vm, restarting, session = state) {
  const common = `This is an authorized disposable WorkSSH VM test. WORKSSH_SESSION=${session.id} WORKSSH_VM_INDEX=${vm.index}. Use only ${vm.scratch}. Never print credentials, config contents, logs or environment dumps. Use the normal per-command reviewer with sandbox_permissions=require_escalated and an honest scratch-only ${restarting ? "recovery" : "installation"} justification. Do not override a reviewer rejection, change global policies or proxies, or bypass a network/authentication denial. The user authorizes a detached SSH supervisor, independent of the model command session, under its own timeout ending no later than ${vm.pendingAgentDeadline}. Do not add keepalives or wait for the lifetime to elapse.`;
  return `${common} ${restarting ? "Use only the EXISTING supervisor/config and host key; never reinstall or regenerate files. If an existing process has no matching launch journal, stop and report it rather than guessing." : "The pinned installer and the embedded bounded launcher are the reviewed implementation."} Execute the exact multiline command in the fenced block below once through normal approval, including its literal heredoc delimiters. Do not wrap it in bash -c, escape it again, or rewrite it. If the command is still running, collect its output with its returned session ID. Empty initial output is not failure. Report the exact HOST_PUBLIC_KEY and WORKSSH_AGENT lines from successful command output. Do not use shell tracing, printenv or HOME overrides.\n\n\`\`\`bash\n${setupCommand(vm, restarting, session)}\n\`\`\``;
}
async function startSetup(vm, restarting) {
  checkInterrupted();
  const socket = await rpc();
  vm.pendingAgentDeadline = agentDeadline;
  vm.setupPending = true;
  vm.lastSetupWasRestart = restarting;
  save();
  const result = await socket.call("turn/start", { threadId: vm.threadId, model: state.model, effort: "medium", input: [{ type: "text", text: setupPrompt(vm, restarting), text_elements: [] }] });
  vm.turnId = result.turn.id;
  vm.setupPending = false;
  save();
  progress(`VM ${vm.index}: ${restarting ? "checking existing agent" : "setup task started"}`);
}

async function finishSetup(vm) {
  const result = await (await rpc()).wait(vm.threadId, vm.turnId);
  if (result.status !== "completed" || !result.hostPublicKey) throw new Error(`VM ${vm.index} did not report a host key: ${result.message ?? result.status}`);
  if (vm.hostPublicKey && canonicalHostKey(vm.hostPublicKey) !== canonicalHostKey(result.hostPublicKey)) throw new Error(`VM ${vm.index} host key changed; refusing automatic acceptance. Use down and create a fresh session`);
  if (!result.agentProcess || !Number.isFinite(Date.parse(result.agentProcess.deadline)) || Date.parse(result.agentProcess.deadline) > Date.parse(vm.pendingAgentDeadline)) throw new Error(`VM ${vm.index} did not confirm a bounded agent launch; inspect its task before retrying`);
  vm.hostPublicKey = canonicalHostKey(result.hostPublicKey);
  vm.agentDeadline = result.agentProcess.deadline;
  delete vm.pendingAgentDeadline;
  save();
  const marker = `WORKSSH_READY_${state.id}_${vm.index}`;
  const output = await run("ssh", ["-T", ...sshArgs(vm), `printf '%s' ${quote(marker)}`], { timeout: 40_000 });
  if (!output.includes(marker)) throw new Error(`VM ${vm.index} SSH readiness challenge failed`);
  vm.readyAt = new Date().toISOString();
  save();
  progress(`VM ${vm.index}: pinned SSH connection verified`);
}

async function ownedThreads() {
  if (!state.configId) return [];
  return (await pages("/v1/threads?limit=100", "data", "nextCursor")).filter((t) => t.environments?.some((e) => e.environmentConfigId === state.configId));
}

// Reconcile unknown POST outcomes by this session's unique metadata, never by
// reissuing a creation request. Ambiguous thread assignment blocks resume.
async function reconcile() {
  if (!state.configId && state.configPending) {
    const matches = (await pages("/v1/environment-configs?scope=user&limit=100&omitDraft=true", "data", "next_cursor")).filter((c) => c.name === state.configName);
    if (matches.length > 1) throw new Error("Ambiguous config creation; inspect the session's uniquely named configs before cleanup");
    if (matches.length) state.configId = matches[0].id;
  }
  if (state.configId && !state.configDeleted) {
    try {
      const owned = await cloud("GET", `/v1/environment-configs/${segment(state.configId)}`);
      if (owned.name !== state.configName) throw new Error("Saved config does not match this session's ownership marker");
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 404)) throw error;
      state.configDeleted = true;
    }
    const entries = await pages("/v1/personal-secrets?namespace=not_sensitive", "secrets", "next_cursor");
    const matches = entries.filter((s) => s.env_var === state.variableName && s.target?.type === "environment_config_ids" && s.target.ids.length === 1 && s.target.ids[0] === state.configId);
    if (matches.length > 1) throw new Error("Ambiguous scoped vault entry; refusing cleanup by name alone");
    if (matches.length) state.vaultId = matches[0].id;
    const threads = await ownedThreads();
    state.discoveredThreadIds = threads.map((t) => t.id);
    state.discoveredRuntimes = threads.flatMap((t) => t.environments.filter((e) => e.environmentConfigId === state.configId).map((e) => e.environmentId));
    const known = new Set(state.vms.map((v) => v.threadId).filter(Boolean));
    const unmatched = threads.filter((t) => !known.has(t.id));
    const pending = state.vms.filter((v) => v.allocationPending);
    if (pending.length === 1 && unmatched.length === 1) {
      pending[0].threadId = unmatched[0].id;
      pending[0].runtimeId = unmatched[0].environments[0].environmentId;
      pending[0].allocationPending = false;
      pending[0].allocationRecovered = true;
    }
    for (const vm of state.vms.filter((v) => v.threadId && (v.setupPending || !v.hostPublicKey))) {
      const turns = (await cloud("GET", `/v2/threads/${segment(vm.threadId)}/turns?limit=1&sortDirection=desc&itemsView=full`)).data;
      if (turns.length) {
        const turn = turns[0];
        vm.turnId = turn.id;
        vm.setupPending = false;
        vm.recoveredTurnStatus = turn.status;
        const messages = turn.items.filter((i) => i.type === "agentMessage").map((i) => i.text).join("\n");
        const match = messages.match(/HOST_PUBLIC_KEY=(ssh-ed25519\s+[A-Za-z0-9+/=]+)/);
        if (match) {
          if (vm.hostPublicKey && canonicalHostKey(vm.hostPublicKey) !== canonicalHostKey(match[1])) throw new Error(`VM ${vm.index} host key changed`);
          vm.hostPublicKey = canonicalHostKey(match[1]);
        }
      }
    }
  }
  if (state.configId && state.configDeleted && state.vaultPending && !state.vaultId) {
    const entries = await pages("/v1/personal-secrets?namespace=not_sensitive", "secrets", "next_cursor");
    const matches = entries.filter((s) => s.env_var === state.variableName && s.target?.ids?.length === 1 && s.target.ids[0] === state.configId);
    if (matches.length > 1) throw new Error("Ambiguous scoped vault entry");
    if (matches.length) state.vaultId = matches[0].id;
  }
  save();
}

async function resume() {
  await reconcile();
  if (state.closed || state.vms.length !== state.count || state.vms.some((v) => !v.threadId || v.allocationPending || v.allocationRecovered)) throw new Error("Provisioning was incomplete or its outcome was uncertain. Do not allocate duplicates; inspect status and use down before a fresh up");
  await consent();
  const socket = await rpc();
  for (const vm of state.vms) {
    const resumed = await socket.call("thread/resume", { threadId: vm.threadId, excludeTurns: true });
    const runtime = resumed.thread.environments?.[0]?.environmentId;
    if (runtime !== vm.runtimeId) throw new Error(`VM ${vm.index} runtime changed; use down instead of trusting a replacement`);
    const turns = (await cloud("GET", `/v2/threads/${segment(vm.threadId)}/turns?limit=1&sortDirection=desc&itemsView=notLoaded`)).data;
    if (turns[0]?.status === "inProgress") {
      vm.turnId = turns[0].id;
    } else {
      if (!vm.hostPublicKey) throw new Error(`VM ${vm.index} setup did not complete; inspect its task before down. A rejected setup is not automatically retried`);
      await startSetup(vm, true);
    }
  }
  await Promise.all(state.vms.map(finishSetup));
  state.phase = "ready";
  save();
  return summary(true);
}

function sshArgs(vm) {
  if (state.closed || !vm?.hostPublicKey) throw new Error("VM is not ready; inspect status or resume");
  const config = path.join(directory, `vm-${vm.index}.json`);
  const hosts = path.join(directory, `host-${vm.index}`);
  // Rebuild only local client files from private canonical session state.
  privateJson(config, { workerUrl: state.workerUrl, relayToken: state.relayToken, tunnelId: vm.tunnelId, transport: "websocket" });
  fs.writeFileSync(hosts, `workssh.invalid ${canonicalHostKey(vm.hostPublicKey)}\n`, { mode: 0o600 });
  return ["-F", "/dev/null", "-o", "BatchMode=yes", "-o", "ConnectTimeout=30", "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${hosts}`, "-o", "GlobalKnownHostsFile=/dev/null", "-o", "IdentitiesOnly=yes", "-i", path.join(directory, "client_key"), "-o", `ProxyCommand=node ${quote(path.join(root, "tunnel/src/proxy.mjs"))} --config ${quote(config)}`, "root@workssh.invalid"];
}

const measurement = `import json,os,platform,socket,shutil,pathlib,time
cpu=pathlib.Path('/sys/fs/cgroup/cpu.max').read_text().strip().split();mem=pathlib.Path('/sys/fs/cgroup/memory.max').read_text().strip();disk=shutil.disk_usage('/')
model=next((s.split(':',1)[1].strip() for s in pathlib.Path('/proc/cpuinfo').read_text().splitlines() if s.startswith('model name')),None)
print(json.dumps({'hostname':socket.gethostname(),'uid':os.getuid(),'arch':platform.machine(),'cpu_model':model,'cpu_quota':cpu[0],'cpu_period':cpu[1],'vcpus':int(cpu[0])/int(cpu[1]) if cpu[0]!='max' else None,'memory_limit_bytes':int(mem) if mem!='max' else None,'disk_total_bytes':disk.total,'disk_free_bytes':disk.free}),flush=True)
time.sleep(HOLD_SECONDS)
print('WORKSSH_OVERLAP_DONE',flush=True)`;

async function verify() {
  if (state.vms.length !== state.count) throw new Error("Not all requested VMs were allocated");
  const hold = number(options["hold-seconds"] ?? "20", "--hold-seconds", 1, 120);
  const children = [];
  const { createInterface } = await import("node:readline");
  try {
    await Promise.all(state.vms.map(async (vm) => {
      const child = spawn("ssh", ["-T", ...sshArgs(vm), `python3 -c ${quote(measurement.replace("HOLD_SECONDS", String(hold)))}`], { stdio: ["ignore", "pipe", "pipe"] });
      const item = { child, vm, stderr: "", done: false, exit: null };
      children.push(item);
      child.stderr.on("data", (chunk) => { item.stderr = (item.stderr + chunk).slice(-3000); });
      const lines = createInterface({ input: child.stdout });
      const completed = new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => { item.exit = code; resolve(); });
      });
      item.completed = completed;
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`VM ${vm.index} SSH readiness timed out`)), 40_000);
        lines.on("line", (line) => {
          try {
            if (!vm.measurementPending) return;
            vm.specs = JSON.parse(line);
            vm.measurementPending = false;
            clearTimeout(timeout);
            resolve();
          } catch (error) { clearTimeout(timeout); reject(error); }
        });
        completed.then(() => { clearTimeout(timeout); if (vm.measurementPending) reject(new Error(`VM ${vm.index} SSH exited before measurements: ${item.stderr}`)); }, reject);
      });
      lines.on("line", (line) => { if (line === "WORKSSH_OVERLAP_DONE") item.done = true; });
    }));
    if (children.some((c) => c.child.exitCode !== null)) throw new Error("SSH commands did not overlap; increase --hold-seconds");
    for (const field of ["runtimeId", "hostPublicKey"]) if (new Set(state.vms.map((v) => v[field])).size !== state.count) throw new Error(`VMs did not have distinct ${field} values`);
    if (new Set(state.vms.map((v) => v.specs.hostname)).size !== state.count) throw new Error("VM hostnames were not distinct");
    await Promise.all(children.map((c) => c.completed));
    if (children.some((c) => c.exit !== 0 || !c.done)) throw new Error("An SSH measurement failed or did not complete its overlap hold");
    state.verification = { count: state.count, verifiedAt: new Date().toISOString(), holdSeconds: hold, allExitZero: true };
    state.phase = "ready";
    for (const vm of state.vms) vm.readyAt = state.verification.verifiedAt;
    save();
    return { ...summary(true), verification: state.verification, specs: state.vms.map((v) => ({ vm: v.index, ...v.specs })), maximumEstablished: false };
  } finally {
    for (const child of children) if (child.child.exitCode === null) child.child.kill("SIGTERM");
  }
}

async function down() {
  state.phase = "deleting";
  save();
  await reconcile();
  const errors = [];
  async function step(label, action) {
    try { await action(); save(); }
    catch (error) { errors.push(`${label}: ${error.message}`); }
  }
  const threads = new Set([...(await ownedThreads()).map((t) => t.id), ...state.vms.map((v) => v.threadId).filter(Boolean), ...(state.discoveredThreadIds ?? [])]);
  state.archivedThreadIds ??= [];
  for (const vm of state.vms.filter((v) => v.hostPublicKey && !v.offline && !v.remoteSecretsRemoved)) {
    try {
      const files = ["agent.json", "host_key", "host_key.pub"].map((name) => quote(`${vm.scratch}/state/${name}`));
      await run("ssh", ["-T", ...sshArgs(vm), `rm -f -- ${files.join(" ")}`], { timeout: 40_000 });
      vm.remoteSecretsRemoved = true;
      save();
    } catch {
      progress(`VM ${vm.index}: remote file cleanup unavailable; revoking relay access and checking runtime shutdown instead`);
    }
  }
  for (const id of threads) if (!state.archivedThreadIds.includes(id)) await step(`thread ${id}`, async () => {
    const socket = await rpc();
    const endpoint = `/v2/threads/${segment(id)}/turns?limit=1&sortDirection=desc&itemsView=notLoaded`;
    const turns = (await cloud("GET", endpoint)).data;
    if (turns[0]?.status === "inProgress") {
      await socket.call("turn/interrupt", { threadId: id, turnId: turns[0].id });
      for (let attempt = 0; attempt < 15; attempt++) {
        if ((await cloud("GET", endpoint)).data[0]?.status !== "inProgress") break;
        if (attempt === 14) throw new Error("Turn interruption not confirmed");
        await delay(1000);
      }
    }
    await socket.call("thread/archive", { threadId: id });
    state.archivedThreadIds.push(id);
  });
  if (state.vaultId && !state.vaultDeleted) await step("vault", async () => {
    const entries = await pages("/v1/personal-secrets?namespace=not_sensitive", "secrets", "next_cursor");
    const entry = entries.find((s) => s.id === state.vaultId);
    if (entry) {
      if (entry.env_var !== state.variableName || entry.target?.ids?.length !== 1 || entry.target.ids[0] !== state.configId) throw new Error("Vault ownership marker mismatch");
      await cloud("DELETE", "/v1/personal-secrets", { namespace: "not_sensitive", ids: [state.vaultId] });
    }
    if ((await pages("/v1/personal-secrets?namespace=not_sensitive", "secrets", "next_cursor")).some((s) => s.id === state.vaultId)) throw new Error("Vault deletion not confirmed");
    state.vaultDeleted = true;
  });
  if (state.configId && !state.configDeleted) await step("config", async () => {
    await absentAfterDelete(() => cloud("DELETE", `/v1/environment-configs/${segment(state.configId)}`), () => cloud("GET", `/v1/environment-configs/${segment(state.configId)}`));
    state.configDeleted = true;
  });
  if (state.workerOwned && !state.workerDeleted) await step("relay", async () => {
    if (state.namespaceId === undefined) {
      try { state.namespaceId = (await cloudflare("GET", `${workerPath()}/settings`)).result.bindings.find((b) => b.name === "TUNNELS")?.namespace_id ?? null; }
      catch (error) { if (!(error instanceof ApiError && error.status === 404)) throw error; }
      save();
    }
    await absentAfterDelete(() => cloudflare("DELETE", workerPath()), () => cloudflare("GET", `${workerPath()}/settings`));
    if (state.namespaceId) {
      const remaining = (await cloudflare("GET", `/accounts/${segment(state.cloudflareAccountId)}/workers/durable_objects/namespaces`)).result;
      if (remaining.some((n) => n.id === state.namespaceId)) throw new Error("Probe namespace deletion not confirmed");
    }
    state.workerDeleted = true;
  });
  const runtimes = new Set([...state.vms.map((v) => v.runtimeId).filter(Boolean), ...(state.discoveredRuntimes ?? [])]);
  for (const id of runtimes) await step(`runtime ${id} teardown`, async () => {
    for (let attempt = 0; attempt < 20; attempt++) {
      const result = await request(RUNTIMES, cloudHeaders, "GET", `/api/cloud/environment/${segment(id)}/status`);
      if (result.status === "offline") {
        const vm = state.vms.find((v) => v.runtimeId === id);
        if (vm) vm.offline = true;
        return;
      }
      if (attempt === 19) throw new Error(`Runtime is ${result.status}, not offline; retry down after teardown completes`);
      await delay(1000);
    }
  });
  if (errors.length) throw new Error(`Cleanup incomplete; state and local keys retained:\n${errors.join("\n")}\nRun down again after inspecting failures`);
  delete state.relayToken;
  state.phase = "deleting-local-state";
  save();
  for (const name of ["client_key", "client_key.pub", "bundle", "build-config", ...state.vms.flatMap((v) => [`vm-${v.index}.json`, `host-${v.index}`])]) fs.rmSync(path.join(directory, name), { recursive: true, force: true });
  state.closed = true;
  state.phase = "deleted";
  save();
  return summary();
}

async function absentAfterDelete(remove, read) {
  try { await remove(); } catch (error) { if (!(error instanceof ApiError && error.status === 404)) throw error; }
  try { await read(); } catch (error) { if (error instanceof ApiError && error.status === 404) return; throw error; }
  throw new Error("Resource still exists after deletion");
}

export function sessionSummary(session, stateDirectory, sshVerified = false) {
  return {
    stateDirectory, phase: session.phase, model: session.model, count: session.count,
    vms: session.vms.map((v) => {
      const setupComplete = session.phase === "ready" && !v.offline && Boolean(v.hostPublicKey);
      const agentDeadlineElapsed = v.agentDeadline ? Date.now() >= Date.parse(v.agentDeadline) : null;
      return {
        index: v.index, threadId: v.threadId, runtimeId: v.runtimeId, offline: v.offline ?? false,
        setupComplete, ready: !setupComplete || agentDeadlineElapsed ? false : sshVerified ? true : null,
        sshReachability: agentDeadlineElapsed ? "expired" : sshVerified ? "reachable" : "not-probed", lastSshVerifiedAt: v.readyAt ?? null,
        agentDeadline: v.agentDeadline ?? null, agentDeadlineElapsed,
        hostKeySha256: v.hostPublicKey ? crypto.createHash("sha256").update(canonicalHostKey(v.hostPublicKey)).digest("hex") : null,
      };
    }),
    ...(session.verification ? { verification: session.verification } : {}),
  };
}

function summary(sshVerified = false) { return sessionSummary(state, directory, sshVerified); }

async function main() {
  const raw = process.argv.slice(2);
  const separator = raw.indexOf("--");
  const cliArgs = separator < 0 ? raw : raw.slice(0, separator);
  if (cliArgs.includes("--help") || cliArgs.includes("-h") || cliArgs[0] === "help") { process.stdout.write(help); return; }
  if (cliArgs.includes("--version")) { console.log("0.1.0"); return; }
  const forwarded = separator < 0 ? [] : raw.slice(separator + 1);
  const parsed = parseArgs({ args: cliArgs, allowPositionals: true, options: {
    "state-dir": { type: "string" }, model: { type: "string" }, count: { type: "string" }, "lifetime-minutes": { type: "string" }, "agent-deadline": { type: "string" }, "hold-seconds": { type: "string" }, vm: { type: "string" }, "auth-file": { type: "string" }, "cloudflare-env": { type: "string" }, "account-id": { type: "string" }, "allow-credits": { type: "boolean" }, "dry-run": { type: "boolean" }, yes: { type: "boolean" }, json: { type: "boolean" },
  } });
  options = parsed.values;
  const [command, ...extra] = parsed.positionals;
  if (!["up", "status", "resume", "ssh", "verify", "down"].includes(command) || extra.length) throw new UsageError("Choose up, status, resume, ssh, verify or down; use --help");
  if (forwarded.length && command !== "ssh") throw new UsageError("Only ssh accepts a command after --");
  const count = number(options.count ?? "1", "--count", 1, 8);
  let lifetime = number(options["lifetime-minutes"] ?? "20", "--lifetime-minutes", 1, 43200);
  if ((options["lifetime-minutes"] || options["agent-deadline"]) && !["up", "resume"].includes(command)) throw new UsageError("Access duration is supported only for up or resume");
  if (options["lifetime-minutes"] && options["agent-deadline"]) throw new UsageError("Choose --lifetime-minutes or --agent-deadline, not both");
  if (options["agent-deadline"]) {
    const now = Date.now();
    agentDeadline = new Date(number(options["agent-deadline"], "--agent-deadline", now + 1, now + 2_592_000_000)).toISOString();
    lifetime = Math.ceil((Date.parse(agentDeadline) - now) / 60_000);
  }
  if (options["hold-seconds"]) number(options["hold-seconds"], "--hold-seconds", 1, 120);
  if (options.model && command !== "up") throw new UsageError("--model is set at creation; resume retains the saved model");
  if (options["dry-run"]) {
    if (command !== "up") throw new UsageError("--dry-run is supported only for up");
    console.log(JSON.stringify({ command, model: options.model ?? "gpt-6-luna", count, lifetimeMinutes: lifetime, agentDeadline, resources: ["private environment config", "scoped vault value", "dedicated Worker/SQLite namespace", `${count} independent VM/setup tasks`], mutates: false }, null, 2));
    return;
  }
  if (!options["state-dir"]) throw new UsageError("--state-dir PATH is required");
  if (command === "down" && !options.yes) throw new UsageError("down deletes this session's resources; supply --yes");
  directory = path.resolve(options["state-dir"].replace(/^~(?=\/)/, os.homedir()));
  if (command === "up") {
    fs.mkdirSync(path.dirname(directory), { recursive: true, mode: 0o700 });
    fs.mkdirSync(directory, { mode: 0o700 });
    state = { version: 1, id: crypto.randomBytes(12).toString("hex"), model: options.model ?? "gpt-6-luna", count, lifetimeMinutes: lifetime, phase: "creating", vms: [], relayToken: crypto.randomBytes(32).toString("hex") };
    state.configName = `WorkSSH ${state.id}`;
    state.variableName = `WORKSSH_${state.id.toUpperCase()}`;
    state.workerName = `workssh-${state.id}`;
    save();
  } else {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || (stat.mode & 0o077)) throw new Error("State directory must be a private directory, mode 0700");
    state = readPrivateJson(path.join(directory, "session.json"));
    if (state.version !== 1) throw new Error("Unsupported session state version");
  }
  secrets.push(state.relayToken);
  if (["resume", "ssh", "verify"].includes(command) && (state.closed || state.phase.startsWith("delet") || state.configDeleted || state.vaultDeleted || state.workerDeleted)) throw new Error("Session teardown has started; only status or down may use it");
  if (["up", "resume"].includes(command)) agentDeadline ??= new Date(Date.now() + Number(options["lifetime-minutes"] ?? state.lifetimeMinutes) * 60_000).toISOString();
  if (["ssh", "verify"].includes(command)) {
    const selected = command === "ssh" ? state.vms.filter((vm) => vm.index === number(options.vm ?? "1", "--vm", 1, state.count)) : state.vms;
    const expired = selected.find((vm) => vm.agentDeadline && Date.now() >= Date.parse(vm.agentDeadline));
    if (expired) throw new Error(`VM ${expired.index} SSH access expired at ${expired.agentDeadline}; VM deletion is not established. Reconnect explicitly with resume --state-dir ${quote(directory)} --lifetime-minutes ${state.lifetimeMinutes}`);
  }
  if (command === "verify") for (const vm of state.vms) vm.measurementPending = true;
  if (command === "ssh") {
    const index = number(options.vm ?? "1", "--vm", 1, state.count);
    await run("ssh", [...sshArgs(state.vms.find((v) => v.index === index)), ...(forwarded.length ? [forwarded.map(quote).join(" ")] : [])], { stdio: "inherit" });
    return;
  }
  const lock = path.join(directory, ".lock");
  try { fs.mkdirSync(lock, { mode: 0o700 }); } catch (error) { if (error.code === "EEXIST") throw new Error(`Session is locked. Check its other CLI process; after a crash, inspect state before removing ${lock}`); throw error; }
  fs.writeFileSync(path.join(lock, "pid"), String(process.pid), { mode: 0o600 });
  process.once("SIGINT", () => { interrupted = true; progress("Interrupted; retaining recoverable state"); connection?.close(); });
  try {
    if (command === "verify") {
      const result = await verify();
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    cloudHeaders = cloudCredentials(options["auth-file"]);
    secrets.push(cloudHeaders.Authorization.slice(7));
    if (state.cloudAccount && state.cloudAccount !== cloudHeaders["ChatGPT-Account-ID"]) throw new Error("OAuth account differs from this session's owner");
    state.cloudAccount = cloudHeaders["ChatGPT-Account-ID"];
    if (command === "up" || command === "down") {
      cf = cloudflareCredentials(options["cloudflare-env"]);
      secrets.push(...Object.values(cf.headers).map((value) => value.replace(/^Bearer /, "")));
    }
    let result;
    if (command === "up") result = await up(count);
    else if (command === "resume") result = await resume();
    else if (command === "down") result = state.closed ? summary() : await down();
    else {
      if (!state.closed) await reconcile();
      result = summary();
      if (!state.closed) result.runtimeStates = await Promise.all(state.vms.filter((v) => v.runtimeId).map(async (v) => {
        const live = await request(RUNTIMES, cloudHeaders, "GET", `/api/cloud/environment/${segment(v.runtimeId)}/status`);
        return { vm: v.index, status: live.status };
      }));
    }
    console.log(options.json ? JSON.stringify(result, null, 2) : `${result.phase}: ${result.count} VM(s). State: ${directory}\n${command === "up" || command === "resume" ? "Run verify, ssh, or down --yes with this state directory." : JSON.stringify(result)}`);
  } finally { connection?.close(); fs.rmSync(lock, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch((error) => {
  console.error(redact(error.message, secrets));
  if (state && !state.closed && directory) console.error(`Session retained at ${directory}. Inspect status or run down --yes before another up.`);
  process.exitCode = interrupted ? 130 : error instanceof UsageError || error.code?.startsWith("ERR_PARSE_ARGS") ? 2 : 1;
});
