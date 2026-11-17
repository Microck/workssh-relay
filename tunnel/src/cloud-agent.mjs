// These functions are embedded in the reviewed cloud command. Keep the launcher
// self-contained: the remote checkout is pinned and need not contain this module.
export function canonicalHostKey(value) {
  const match = value.trim().match(/^(ssh-ed25519)\s+([A-Za-z0-9+/=]+)(?:\s|$)/);
  if (!match) throw new Error("Expected an Ed25519 public host key");
  return match[1] + " " + match[2];
}

export async function launchAgent({ scratch, deadline, expectedHostKey }) {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const { spawn } = await import("node:child_process");
  const { once } = await import("node:events");
  const { setTimeout: delay } = await import("node:timers/promises");
  const state = path.join(scratch, "state");
  const config = path.join(state, "agent.json");
  const source = path.join(scratch, "repo/tunnel/src");
  const supervisor = path.join(source, "supervisor.mjs");
  const journal = path.join(state, "agent-process.json");
  const lock = path.join(state, "agent-launch.lock");
  await fs.access(config);
  await fs.access(supervisor);
  const hostPublicKey = canonicalHostKey(await fs.readFile(path.join(state, "host_key.pub"), "utf8"));
  if (expectedHostKey && canonicalHostKey(expectedHostKey) !== hostPublicKey) throw new Error("Original host key changed; refusing recovery");
  // A failed/uncertain launch retains its journal. Never remove another launch's
  // lock, adopt a substring match, or silently renew an already-running process.
  await fs.mkdir(lock, { mode: 0o700 });
  try {
    const scripts = [supervisor, path.join(source, "agent.mjs"), path.join(source, "ssh-server.mjs")];
    const ownedProcesses = async () => {
      const matches = [];
      for (const pid of await fs.readdir("/proc")) {
        if (!/^\d+$/.test(pid)) continue;
        let args;
        try { args = (await fs.readFile(path.join("/proc", pid, "cmdline"), "utf8")).split("\0"); }
        catch (error) { if (["ENOENT", "ESRCH", "EACCES"].includes(error.code)) continue; throw error; }
        if (!args.some((arg, index) => arg === "--config" && args[index + 1] === config)) continue;
        const script = scripts.find((candidate) => args[1] === candidate);
        if (script) matches.push({ pid: Number(pid), script });
      }
      return matches;
    };
    const running = await ownedProcesses();
    const supervisors = running.filter((item) => item.script === supervisor);
    if (supervisors.length > 1) throw new Error("Multiple exact supervisors exist; inspect before recovery");
    if (supervisors.length === 1) {
      const previous = JSON.parse(await fs.readFile(journal, "utf8"));
      if (previous.supervisorPid !== supervisors[0].pid || canonicalHostKey(previous.hostPublicKey) !== hostPublicKey) throw new Error("Existing supervisor does not match its bounded launch record");
      return { ...previous, started: false };
    }
    if (running.length) throw new Error("Orphaned agent processes exist; inspect before recovery");
    const remaining = Math.floor((Date.parse(deadline) - Date.now()) / 1000);
    if (!Number.isFinite(remaining) || remaining < 1) throw new Error("Agent deadline has elapsed; no process started");
    const logPath = path.join(state, "agent-" + Date.now() + ".log");
    const log = await fs.open(logPath, "wx", 0o600);
    let child;
    try {
      child = spawn("timeout", ["--signal=TERM", "--kill-after=5s", remaining + "s", process.execPath, supervisor, "--config", config], {
        detached: true, stdio: ["ignore", log.fd, log.fd],
      });
      await once(child, "spawn");
    } finally { await log.close(); }
    // The timeout owns the process group and all descendants, independently of
    // the model command session. Never inherit its stdio or create a keepalive.
    child.unref();
    const report = { started: true, wrapperPid: child.pid, deadline, hostPublicKey, logPath };
    const save = async () => {
      const temporary = journal + "." + process.pid + ".tmp";
      await fs.writeFile(temporary, JSON.stringify(report) + "\n", { mode: 0o600, flag: "wx" });
      await fs.rename(temporary, journal);
    };
    // Journal the wrapper immediately so an uncertain startup is inspectable.
    await save();
    for (let attempt = 0; attempt < 50; attempt++) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error("Bounded supervisor exited during launch; inspect its private log");
      const current = (await ownedProcesses()).find((item) => item.script === supervisor);
      if (current) {
        report.supervisorPid = current.pid;
        await save();
        return report;
      }
      await delay(20);
    }
    throw new Error("Supervisor launch is unconfirmed; inspect the retained launch record before retrying");
  } finally { await fs.rmdir(lock); }
}

export function agentLaunchCommand(options) {
  const source = `${canonicalHostKey.toString()}\n${launchAgent.toString()}\nconst options = ${JSON.stringify(options)};\noptions.scratch = process.env.WORKSSH_SETUP_SCRATCH;\nconst report = await launchAgent(options);\nconsole.log('HOST_PUBLIC_KEY=' + report.hostPublicKey);\nconsole.log('WORKSSH_AGENT=' + JSON.stringify(report));`;
  return `node --input-type=module <<'WORKSSH_AGENT_LAUNCH'\n${source}\nWORKSSH_AGENT_LAUNCH`;
}
