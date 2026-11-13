import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import https from "node:https";
import http from "node:http";
import crypto from "node:crypto";
import WebSocket from "ws";

export const CLOUD = "https://codex-cloud-backend.chatgpt.com";
export const RUNTIMES = "https://codex-cloud-environments.chatgpt.com";
export const CLOUDFLARE = "https://api.cloudflare.com/client/v4";

export class ApiError extends Error {
  constructor(method, url, status, payload) {
    super(`${method} ${url.pathname}: HTTP ${status}: ${JSON.stringify(payload)}`);
    this.status = status;
  }
}

// Native HTTP is intentional: the cloud service has rejected Node fetch while
// accepting native HTTPS with the same OAuth identity. Never follow redirects
// with credentials, retry mutations, or substitute another origin after denial.
export function request(base, headers, method, endpoint, body, contentType = "application/json") {
  const url = new URL(`${base}${endpoint}`);
  const bytes = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const req = transport.request(url, {
      method,
      headers: { ...headers, ...(bytes ? { "Content-Type": contentType, "Content-Length": bytes.length } : {}) },
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on("data", (chunk) => {
        size += chunk.length;
        if (size > 16 * 1024 * 1024) res.destroy(new Error("API response exceeded 16 MiB"));
        else chunks.push(chunk);
      });
      res.on("error", reject);
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let payload;
        try { payload = text ? JSON.parse(text) : {}; }
        catch { payload = text.slice(0, 1000); }
        if (res.statusCode < 200 || res.statusCode >= 300) reject(new ApiError(method, url, res.statusCode, payload));
        else resolve(payload);
      });
    });
    req.setTimeout(45_000, () => req.destroy(new Error(`${method} ${url.pathname}: request timed out; inspect state before retrying a mutation`)));
    req.on("error", reject);
    if (bytes) req.write(bytes);
    req.end();
  });
}

export function privateJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function readPrivateJson(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || (stat.mode & 0o077)) throw new Error(`Expected a private regular file, mode 0600: ${file}`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function cloudCredentials(file = path.join(os.homedir(), ".codex/auth.json")) {
  const { tokens } = readPrivateJson(file);
  if (!tokens?.access_token || !tokens.account_id) throw new Error(`No Codex OAuth login in ${file}; run codex login`);
  return { Authorization: `Bearer ${tokens.access_token}`, "ChatGPT-Account-ID": tokens.account_id };
}

export function cloudflareCredentials(file) {
  const values = {};
  if (file) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || (stat.mode & 0o077)) throw new Error(`Cloudflare credentials must be a private regular file: ${file}`);
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const match = line.match(/^(?:export\s+)?(CLOUDFLARE_[A-Z_]+)=(.*)$/);
      if (match) values[match[1]] = match[2].trim().replace(/^(["'])(.*)\1$/, "$2");
    }
  }
  for (const key of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_API_KEY", "CLOUDFLARE_EMAIL", "CLOUDFLARE_ACCOUNT_ID"]) {
    if (process.env[key]) values[key] = process.env[key];
  }
  const headers = values.CLOUDFLARE_API_TOKEN
    ? { Authorization: `Bearer ${values.CLOUDFLARE_API_TOKEN}` }
    : values.CLOUDFLARE_API_KEY && values.CLOUDFLARE_EMAIL
      ? { "X-Auth-Key": values.CLOUDFLARE_API_KEY, "X-Auth-Email": values.CLOUDFLARE_EMAIL }
      : null;
  if (!headers) throw new Error("Set CLOUDFLARE_API_TOKEN, or CLOUDFLARE_API_KEY and CLOUDFLARE_EMAIL; alternatively use --cloudflare-env FILE");
  return { headers, accountId: values.CLOUDFLARE_ACCOUNT_ID };
}

export function redact(text, secrets) {
  let safe = String(text);
  for (const secret of secrets) if (secret) safe = safe.split(secret).join("[REDACTED]");
  return safe;
}

export class CloudConnection {
  constructor(socket) {
    this.socket = socket;
    this.sequence = 0;
    this.pending = new Map();
    this.turns = new Map();
    this.waiters = new Map();
    socket.on("message", (raw) => {
      try { this.receive(JSON.parse(raw.toString())); }
      catch (error) { this.fail(error); socket.close(); }
    });
    socket.on("error", (error) => this.fail(error));
    socket.on("close", () => this.fail(new Error("Cloud connection closed; inspect saved thread history before resuming")));
  }

  static async open(headers) {
    const socket = new WebSocket("wss://codex-cloud-backend.chatgpt.com/", [
      "codex-app-server", "codex-client.desktop", `openai-bearer.${headers.Authorization.slice(7)}`,
    ], { headers: { "ChatGPT-Account-ID": headers["ChatGPT-Account-ID"], "X-OpenAI-Product-Sku": "codex" }, handshakeTimeout: 20_000, perMessageDeflate: false });
    await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    const connection = new CloudConnection(socket);
    try {
      await connection.call("initialize", { clientInfo: { name: "workssh_cloud", version: "0.1.0" }, capabilities: { experimentalApi: true } });
      socket.send(JSON.stringify({ method: "initialized" }));
      return connection;
    } catch (error) { socket.close(); throw error; }
  }

  call(method, params) {
    const id = ++this.sequence;
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out; inspect saved state before retrying`)); }, 90_000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }), (error) => {
        if (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
      });
    });
  }

  receive(event) {
    if (event.id !== undefined && event.method) {
      this.socket.send(JSON.stringify({ id: event.id, error: { code: -32601, message: "Interactive requests are not supported by this client" } }));
      this.fail(new Error(`Cloud requested interactive action ${event.method}; inspect the task in the cloud UI. No approval was granted`));
      return;
    }
    if (event.id !== undefined && this.pending.has(event.id)) {
      const pending = this.pending.get(event.id);
      clearTimeout(pending.timer);
      this.pending.delete(event.id);
      if (event.error) pending.reject(new Error(JSON.stringify(event.error)));
      else pending.resolve(event.result);
      return;
    }
    const params = event.params ?? {};
    const turnId = params.turnId ?? params.turn?.id;
    if (!params.threadId || !turnId) return;
    const key = `${params.threadId}/${turnId}`;
    const result = this.turns.get(key) ?? {};
    if (event.method === "item/completed") {
      const item = params.item;
      if (item?.type === "agentMessage") result.message = item.text;
      const output = item?.type === "agentMessage" ? item.text : item?.type === "commandExecution" ? item.aggregatedOutput : "";
      const match = output?.match(/HOST_PUBLIC_KEY=(ssh-ed25519\s+[A-Za-z0-9+/=]+)/);
      if (match) {
        if (result.hostPublicKey && result.hostPublicKey !== match[1]) throw new Error("Cloud task reported inconsistent host keys");
        result.hostPublicKey = match[1];
      }
    }
    if (event.method === "turn/completed") {
      result.status = params.turn.status;
      const waiter = this.waiters.get(key);
      if (waiter) { clearTimeout(waiter.timer); this.waiters.delete(key); waiter.resolve(result); }
    }
    this.turns.set(key, result);
  }

  wait(threadId, turnId, timeout = 300_000) {
    const key = `${threadId}/${turnId}`;
    if (this.error) return Promise.reject(this.error);
    if (this.turns.get(key)?.status) return Promise.resolve(this.turns.get(key));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiters.delete(key); reject(new Error(`Setup observation timed out for ${threadId}; the task may still be running. Use status, resume, or down`)); }, timeout);
      this.waiters.set(key, { resolve, reject, timer });
    });
  }

  fail(error) {
    this.error = error;
    for (const value of [...this.pending.values(), ...this.waiters.values()]) { clearTimeout(value.timer); value.reject(error); }
    this.pending.clear();
    this.waiters.clear();
  }

  close() { this.socket.terminate(); }
}
