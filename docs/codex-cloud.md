# Connect to Codex Cloud over SSH

This fork provisions disposable Codex Cloud VMs and connects them through its Cloudflare relay. It reads your existing Codex OAuth login. It does not create a ChatGPT Work conversation or bypass platform access denials.

## Requirements

- Node.js 22+, npm, OpenSSH and `ssh-keygen` on macOS or Linux.
- A valid `~/.codex/auth.json` from `codex login`. The helper reads it without refreshing or rewriting it.
- Cloudflare Workers deployment credentials. Use `CLOUDFLARE_API_TOKEN`, or `CLOUDFLARE_API_KEY` with `CLOUDFLARE_EMAIL`. A private `--cloudflare-env` file can supply these variables instead.
- Permission to use your Codex allowance and Cloudflare account. Neither service is unlimited or guaranteed free. The helper never changes subscriptions or buys credits.

```bash
git clone https://github.com/Microck/workssh-relay.git
cd workssh-relay
npm --prefix tunnel ci
npm --prefix relay ci
npm run cloud -- up --state-dir ~/.local/state/workssh/demo --count 1
npm run cloud -- verify --state-dir ~/.local/state/workssh/demo
npm run cloud -- ssh --state-dir ~/.local/state/workssh/demo --vm 1 -- uname -a
npm run cloud -- down --state-dir ~/.local/state/workssh/demo --yes
```

`up` starts a short Codex setup task for each VM. If the included allowance is exhausted, it requires `--allow-credits` before using existing credits. This flag never authorizes purchases or top-ups. Cloudflare usage can incur charges under your existing plan.

Setup defaults to `gpt-6-luna` with medium reasoning at Standard speed. It was the lowest-credit model in the available catalog checked against the [Codex rate card](https://developers.openai.com/codex/pricing/). Use `--model ID` at creation to select another available model. The helper fails if the selected model is unavailable; it never silently switches to a more expensive one. `resume` retains the saved model.

## Commands

- `up --count 1..8 --state-dir PATH`: create one private environment config, a config-scoped vault value, a dedicated relay, and independent VM tasks. The state directory must not exist. The count is a helper safety bound, not a platform limit.
- `up --dry-run`: print the intended resource changes without reading credentials, creating files, calling APIs or consuming credits.
- `status --state-dir PATH`: show saved setup progress and live provider runtime states. `ready` is `null` for an unprobed session, or `false` after known teardown/offline state or the recorded agent deadline. `sshReachability` is `expired` after that deadline, otherwise `not-probed`. `setupComplete`, `lastSshVerifiedAt`, and the agent deadline are historical evidence, not current reachability. Provider `connected` does not mean the SSH agent is connected. No SSH probe or model task starts.
- `resume --state-dir PATH [--lifetime-minutes N]`: recover the same runtime and request a restart only after exact argv checks show its supervisor is absent. The existing host-key pin must match before launch. The new process is detached from the model command session, but has its own timeout. The default recovery bound is the saved lifetime; an explicit bound applies only to this recovery. It never allocates replacements or regenerates keys. Credit consent applies to resumed model work too.
- `keepalive --state-dir PATH --json`: issue one native `thread/resume` per saved VM with `excludeTurns: true`. This is separate from model-assisted `resume`. It requires a complete, unexpired, ready session, a connected runtime, a completed latest turn, and the original canonical local host pin. It checks the returned thread/runtime and config association when present, then re-reads the latest turn, runtime status, saved session and local pins. Changed identities or turn ID/status, teardown, expiry, offline runtimes, denials, timeouts and RPC/API failures stop the request without retries. It never starts model work, checks credit consent, installs or repairs an agent, reconciles resources, allocates replacements, renews a deadline or regenerates a pin.
- `ssh --state-dir PATH --vm N -- [command...]`: connect with the saved private identity and pinned host key. Arguments after `--` are literal argv, including empty strings, quotes and multiline code. Use `-- sh -c 'shell expression'` explicitly for shell syntax. With no command, open an interactive shell. It does not edit normal SSH configuration.
- `verify --state-dir PATH`: execute overlapping SSH commands on every saved VM, check distinct runtime IDs, hostnames and host keys, collect CPU/memory/filesystem measurements, and require every command to exit successfully. `--hold-seconds` defaults to 20.
- `down --state-dir PATH --yes`: interrupt active owned setup turns, archive owned threads, delete the session's vault value, config and relay, confirm its runtimes are offline, and remove local private keys/configs. It does not delete other environments or overwrite an existing Worker. If any deletion cannot be confirmed, retain state and return a failure so you can retry cleanup.

Cleanup attempts to remove the remote agent config and host keys before archiving. If SSH is already unavailable, it revokes relay access and checks that the runtime is offline instead. This does not guarantee erasure of platform-retained snapshots.

Once teardown starts, `ssh`, `verify`, `resume`, and `keepalive` refuse that session. Use `status` or repeat `down` to finish cleanup.

Use `--json` for machine-readable results, for example `npm run --silent cloud -- status --state-dir PATH --json`. Progress goes to stderr. `--help` works without credentials. Exit codes are 0 for success, 1 for runtime/API failures, and 2 for invalid arguments.

`--auth-file` selects another Codex auth file. `--cloudflare-env` selects a private credentials file; process environment values take precedence over its values. `--account-id` overrides the account selected by the environment. Secrets are not accepted as command-line values.

`keepalive --json` returns exactly this structure:

```json
{
  "phase": "ready",
  "count": 1,
  "resumed": true,
  "vms": [{
    "index": 1,
    "threadId": "saved-thread-id",
    "runtimeId": "saved-runtime-id",
    "status": "connected",
    "latestTurnId": "unchanged-latest-turn-id",
    "latestTurnStatus": "completed",
    "latestTurnUnchanged": true
  }]
}
```

This reports native resume evidence, not an SSH probe. It makes no `ready: true` or deadline-extension claim. Run `ssh` or `verify` separately to check SSH access. A multi-VM request can stop after earlier VMs have resumed. The helper does not roll back or retry an issued resume. The plugin owns the durable one-shot issued marker and must retain it after failure or an uncertain outcome. The helper does not add a separate attempt journal or automatic retry path.

## Keep the session state private

The state directory contains the short-lived relay token, SSH private key and resource IDs. Directories are private and files are mode 0600. Writes use an atomic replacement, so an interrupted write does not truncate the previous state. Do not commit, upload or share this directory.

Creation requests are not blindly retried after a timeout. If `up` stops, run `status` to reconcile what exists, then `resume` or `down`. An ambiguous allocation fails rather than creating a duplicate. Do not start another `up` against the same state directory.

If a crash leaves `.lock`, check the PID in `.lock/pid` and confirm that CLI process has ended before removing the lock directory. Do not remove a live process's lock.

A host-key mismatch stops the connection and recovery before launch. Identity uses the key type and base64 key data, not its optional comment. `hostKeySha256` is the SHA256 of that canonical two-field text. If the platform replaced a VM, remove the old session with `down` and create a fresh one. Do not disable host-key checking.

## Understand lifetime and approval

The agent's default access window is 20 minutes, including installation. Choose `--lifetime-minutes` from 1 through 43200, such as 480 for an eight-hour work session. The 30-day local limit matches Raft's TTL range; it does not guarantee provider uptime. Integrations can instead pass `--agent-deadline` as an absolute Unix-millisecond deadline, mutually exclusive with minutes. Every VM in an invocation shares that deadline. Setup and the detached SSH supervisor use the same deadline, so returning from the setup command does not end SSH access. A private launch lock and exact process argv checks prevent duplicate supervisors; recovery refuses orphaned child processes and untracked existing supervisors instead of guessing. An expired agent does not establish VM deletion. Explicit `resume` can start another bounded agent on the same runtime. An already-running agent is reused without extending its deadline.

Cloud filesystems may be read-only to ordinary commands. Each new helper task requests `on-request` approval with the platform's `auto_review` reviewer. Setup asks that reviewer for the authorized scratch-only installation. It does not alter global policies or override a rejection. Relay secrets arrive through a scoped vault environment variable and never appear literally in prompts or command strings. Setup stops on network or authentication denials.

`ssh` and `verify` reject an expired access window before opening a connection and report the explicit resume command. They never start model work or renew access automatically. With authorization for another bounded agent, run `npm run cloud -- resume --state-dir PATH --lifetime-minutes 480 --json`, then verify files with `ssh`. If a connection fails before its deadline, inspect status rather than assuming expiry. A failed recovery is not permission to allocate a replacement, regenerate a host key, or retry a denied command.

SDK/Raft uses the same absolute deadline at creation. Use its explicit `provider.reconnect(id, { timeoutMs })` or `raft resume BOX --ttl SECONDS` to recover access and record the helper's confirmed deadline. Direct helper recovery does not extend a separate SDK/Raft access window. For lifetime measurements, calculate `createdAt + timeoutMs` immediately before the check. A delayed scheduled check may already be past that deadline even if its label says "before expiry". Do not rewrite records to make a measurement pass; record missing files, permission failures and unobserved files separately.

The helper preserves multiline Python as one argument:

```bash
npm run --silent cloud -- ssh --state-dir PATH --vm 1 -- python3 -c 'import hashlib
from pathlib import Path
print(hashlib.sha256(Path("/workspace/payload.bin").read_bytes()).hexdigest())'
```

Pass the same arguments individually with `subprocess.run` or `execFile`. Do not prequote or join them into one remote command.

## Tested behavior

A bounded November 2026 experiment verified 2, 4 and 8 independent VMs with overlapping SSH sessions. All eight final sessions used strict host-key verification and exited 0. Each VM had a different runtime ID, hostname and host key.

A one-VM helper smoke also verified secure provisioning, task-history recovery, a real SSH command, measurements, and same-runtime resume with an unchanged host key using GPT-6 Luna. Its setup needed follow-up guidance before completion. The helper now uses medium reasoning, an explicit reviewed script, and pinned upstream agent sources. Model-driven setup can still fail; inspect the task before using `resume` or `down`, and do not override an access denial. That VM reported 31.45 GiB of filesystem capacity, so do not treat the earlier eight-VM disk measurement as a guarantee.

Measured on those eight VMs:

| Measurement | Per VM |
| --- | --- |
| CPU quota | 4 vCPUs |
| Memory limit | 16 GiB |
| Reported filesystem capacity | 62.94 GiB |
| Architecture | x86-64 |
| Reported host CPU | AMD EPYC 9V74 on seven VMs; Intel Xeon Platinum 8573C on one |

Eight is a verified lower bound, not an established maximum. CPU quotas are not dedicated physical cores. Filesystem capacity is not proven reserved storage. No throughput benchmark, long-term lifetime guarantee, or quota exemption was established. All research resources were removed afterward.

The working provisioning path supplies `runtime_requirements` when creating the config and allocates an ordinary task with `deferredEnvironment: false`. It does not depend on the onboarding editor or a draft-publication cycle. These cloud endpoints are unofficial and may change; API errors remain visible.

The original WorkSSH repo assumes an existing Work conversation. Its optional Site ingress handles sandbox-to-relay egress, not ChatGPT task creation. A Work API unusual-activity denial is not fixed or bypassed by this helper.
