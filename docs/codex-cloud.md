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
- `status --state-dir PATH`: show saved progress and live runtime states. Reconcile interrupted resource creation using this session's unique resource names. No model task starts.
- `resume --state-dir PATH`: resume existing task threads and request a restart only after checking that their exact supervisor is absent. It never allocates replacement VMs or silently accepts changed host keys. Credit consent applies to resumed model work too.
- `ssh --state-dir PATH --vm N -- [command...]`: connect with the saved private identity and pinned host key. With no command, open an interactive shell. It does not edit your normal SSH configuration.
- `verify --state-dir PATH`: execute overlapping SSH commands on every saved VM, check distinct runtime IDs, hostnames and host keys, collect CPU/memory/filesystem measurements, and require every command to exit successfully. `--hold-seconds` defaults to 20.
- `down --state-dir PATH --yes`: interrupt active owned setup turns, archive owned threads, delete the session's vault value, config and relay, confirm its runtimes are offline, and remove local private keys/configs. It does not delete other environments or overwrite an existing Worker. If any deletion cannot be confirmed, retain state and return a failure so you can retry cleanup.

Cleanup attempts to remove the remote agent config and host keys before archiving. If SSH is already unavailable, it revokes relay access and checks that the runtime is offline instead. This does not guarantee erasure of platform-retained snapshots.

Once teardown starts, `ssh`, `verify`, and `resume` refuse that session. Use `status` or repeat `down` to finish cleanup.

Use `--json` for machine-readable results, for example `npm run --silent cloud -- status --state-dir PATH --json`. Progress goes to stderr. `--help` works without credentials. Exit codes are 0 for success, 1 for runtime/API failures, and 2 for invalid arguments.

`--auth-file` selects another Codex auth file. `--cloudflare-env` selects a private credentials file; process environment values take precedence over its values. `--account-id` overrides the account selected by the environment. Secrets are not accepted as command-line values.

## Keep the session state private

The state directory contains the short-lived relay token, SSH private key and resource IDs. Directories are private and files are mode 0600. Writes use an atomic replacement, so an interrupted write does not truncate the previous state. Do not commit, upload or share this directory.

Creation requests are not blindly retried after a timeout. If `up` stops, run `status` to reconcile what exists, then `resume` or `down`. An ambiguous allocation fails rather than creating a duplicate. Do not start another `up` against the same state directory.

If a crash leaves `.lock`, check the PID in `.lock/pid` and confirm that CLI process has ended before removing the lock directory. Do not remove a live process's lock.

A host-key mismatch stops the connection. If the platform replaced a VM, remove the old session with `down` and create a fresh one. Do not disable host-key checking.

## Understand lifetime and approval

The agent's default lifetime is 20 minutes, including installation. Set `--lifetime-minutes` at creation to choose a bound from 1 to 120 minutes. This bounds the test process; it cannot prevent the platform from reclaiming the VM. `resume` starts another bounded supervisor only after checking the old one is absent.

Cloud filesystems may be read-only to ordinary commands. Each new helper task requests `on-request` approval with the platform's `auto_review` reviewer. Setup asks that reviewer for the authorized scratch-only installation. It does not alter global policies or override a rejection. Relay secrets arrive through a scoped vault environment variable and never appear literally in prompts or command strings. Setup stops on network or authentication denials.

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
