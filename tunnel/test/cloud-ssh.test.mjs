import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ssh2 from "ssh2";
import { WebSocketServer } from "ws";
import { decodeData, encodeData } from "../src/framing.mjs";
import { privateJson } from "../src/cloud-api.mjs";

const cli = fileURLToPath(new URL("../src/codex-cloud.mjs", import.meta.url));

async function command(program, args, options = {}) {
  const child = spawn(program, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const [code] = await once(child, "close");
  return { code, stdout, stderr };
}

// Only loopback sockets, fixture credentials and disposable guest working files.
// The in-memory relay terminates at a real SSH server; OpenSSH still checks the
// independent host pin and authenticates with the generated private identity.
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workssh-cloud-ssh-"));
  await fs.chmod(root, 0o700);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const name of ["client_key", "host_key"]) {
    const generated = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", path.join(root, name)], { encoding: "utf8" });
    assert.equal(generated.status, 0, generated.stderr);
  }
  const key = path.join(root, "tls-key.pem"), cert = path.join(root, "tls-cert.pem");
  const certificate = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", key, "-out", cert, "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1"], { encoding: "utf8" });
  assert.equal(certificate.status, 0, certificate.stderr);
  const publicKey = ssh2.utils.parseKey(await fs.readFile(path.join(root, "client_key.pub")));
  let executions = 0;
  const ssh = new ssh2.Server({ hostKeys: [await fs.readFile(path.join(root, "host_key"))] }, (client) => {
    client.on("error", () => {});
    client.on("authentication", (context) => {
      if (context.method === "publickey" && context.key.data.equals(publicKey.getPublicSSH()) && (!context.signature || publicKey.verify(context.blob, context.signature, context.hashAlgo))) context.accept();
      else context.reject();
    });
    client.on("ready", () => client.on("session", (accept) => {
      accept().on("exec", (acceptExec, _reject, info) => {
        executions++;
        const channel = acceptExec();
        const process = spawn("sh", ["-c", info.command], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
        channel.pipe(process.stdin);
        process.stdout.pipe(channel, { end: false });
        process.stderr.pipe(channel.stderr, { end: false });
        process.on("close", (code) => { channel.exit(code ?? 1); channel.end(); });
      });
    }));
  });
  ssh.listen(0, "127.0.0.1");
  await once(ssh, "listening");
  t.after(() => ssh.close());
  const tls = https.createServer({ key: await fs.readFile(key), cert: await fs.readFile(cert) });
  const relay = new WebSocketServer({ server: tls });
  const sockets = new Set();
  relay.on("connection", (socket, request) => {
    assert.equal(request.headers["x-relay-token"], "fixture-relay-token-at-least-32-characters");
    assert.equal(new URL(request.url, "https://localhost").searchParams.get("role"), "client");
    const tcp = net.connect(ssh.address().port, "127.0.0.1");
    sockets.add(tcp);
    tcp.on("connect", () => socket.send(JSON.stringify({ type: "peer-ready", protocol: 1 })));
    tcp.on("data", (chunk) => socket.send(encodeData(chunk)));
    socket.on("message", (message) => { const bytes = decodeData(message); if (bytes) tcp.write(bytes); });
    socket.on("close", () => { tcp.destroy(); sockets.delete(tcp); });
    tcp.on("error", () => socket.close());
    tcp.on("end", () => socket.close(1000));
  });
  tls.listen(0, "127.0.0.1");
  await once(tls, "listening");
  t.after(() => { for (const socket of relay.clients) socket.terminate(); for (const socket of sockets) socket.destroy(); relay.close(); tls.closeAllConnections(); tls.close(); });
  const hostPublicKey = (await fs.readFile(path.join(root, "host_key.pub"), "utf8")).trim();
  privateJson(path.join(root, "session.json"), { version: 1, phase: "ready", count: 1, workerUrl: `https://127.0.0.1:${tls.address().port}`, relayToken: "fixture-relay-token-at-least-32-characters", vms: [{ index: 1, tunnelId: "fixture-tunnel-0000000000000001", hostPublicKey }] });
  const env = { ...process.env, NODE_EXTRA_CA_CERTS: cert };
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) delete env[name];
  return { root, executions: () => executions, run: (args) => command(process.execPath, [cli, "ssh", "--state-dir", root, "--vm", "1", "--", ...args], { env, timeout: 10_000 }) };
}

test("helper SSH runs multiline Python with literal paths and keeps strict independent host authentication", { timeout: 20_000 }, async (t) => {
  const { root, run, executions } = await fixture(t);
  const name = "payload ' $(touch INJECTION).bin";
  await fs.writeFile(path.join(root, name), Buffer.from([0, 1, 2, 255]));
  const source = "import hashlib,json,sys\nfrom pathlib import Path\ncontent=Path(sys.argv[1]).read_bytes()\nprint(json.dumps({'sha256':hashlib.sha256(content).hexdigest(),'bytes':len(content)}))\n";
  const result = await run(["python3", "-c", source, path.join(root, name)]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { sha256: crypto.createHash("sha256").update(Buffer.from([0, 1, 2, 255])).digest("hex"), bytes: 4 });
  await assert.rejects(fs.access(path.join(root, "INJECTION")), { code: "ENOENT" });
  const sessionFile = path.join(root, "session.json");
  const session = JSON.parse(await fs.readFile(sessionFile, "utf8"));
  session.vms[0].hostPublicKey = (await fs.readFile(path.join(root, "client_key.pub"), "utf8")).trim();
  privateJson(sessionFile, session);
  const rejected = await run(["python3", "-c", "raise SystemExit('must never execute')"]);
  assert.equal(rejected.code, 1);
  assert.match(rejected.stderr, /HOST IDENTIFICATION HAS CHANGED|Host key verification failed/);
  assert.equal(executions(), 1, "a changed pin must fail before guest code executes");
});

test("expired SSH access fails before connection without renewing or replacing the session", async (t) => {
  const { root, run, executions } = await fixture(t);
  const file = path.join(root, "session.json");
  const session = JSON.parse(await fs.readFile(file, "utf8"));
  session.vms[0].agentDeadline = "2000-01-01T00:00:00Z";
  privateJson(file, session);
  const before = await fs.readFile(file, "utf8");
  const result = await run(["python3", "-c", "raise SystemExit('must not execute')"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /SSH access expired.*resume/s);
  assert.equal(executions(), 0);
  assert.equal(await fs.readFile(file, "utf8"), before);
});
