# Sentinel: an always-on SRE agent on pi-durable

Sentinel is a proof of concept for an SRE agent that stays on. It watches a service, opens an incident when the service breaks, then investigates, fixes, checks the fix and writes up what happened. Several people can follow and steer the same agent from one shared web UI that streams its transcript live.

- **Durable:** built on [`@earendil-works/pi-durable`](https://www.npmjs.com/package/@earendil-works/pi-durable). Every model turn, tool call, operator message and incident record is committed to one SQLite file before it reaches the UI. If the process is killed mid-incident, it resumes from the last checkpoint on restart.
- **Always on:** a built-in health monitor raises incidents by itself. Webhooks (our own JSON format or Alertmanager's) can raise them too.
- **Steerable by many:** everyone sees the same live transcript, including streaming text, tool output, presence and typing indicators. A *Steer* message reaches the agent after its current tool round. A *Note* is only for the humans. Anyone can stop the agent, resolve an incident or reopen it.
- **Guardrails:** destructive shell commands are blocked, and file writes are limited to the working directory. Both are enforced in a `beforeTool` hook, so neither the model nor an operator can get around them.
- **Runs without an API key:** with no `ANTHROPIC_API_KEY` set, a deterministic offline playbook acts as the model. It is exposed through pi-ai's faux provider and still runs the real tools on the real box. Set the key and Claude takes over.
- **Deploys to [boxd](https://boxd.sh):** one script creates the VM, uploads the code, installs a systemd unit and serves the UI at `https://<vm>.boxd.sh`.

```
 alerts ─┐   POST /api/alerts (JSON or Alertmanager)        ┌──────────── web UI (many operators) ───────────┐
monitor ─┤   health probe → incident after N failures        │ incidents · live transcript · steer · presence │
         ▼                                                   └──────────────────────▲─────────────────────────┘
   ┌──────────────────────────── agent/src/server.ts ──────────────────────────────┐│ WebSocket (fan-out of
   │ SreRuntime: dedup + correlation → one pi-durable conversation per incident    ││ conversation watches)
   │ Harness (SQLite) ─ generation task ─ tool tasks ─ guardrail hook ─ resume()   │┘
   │ tools: bash read edit write · http_check · service_control · tail_logs ·      │
   │        update_incident · resolve_incident                                    │
   └──────────────────────────────────────┬────────────────────────────────────────┘
                                          ▼
                          sample-app/ (catalog-api on :9001, run.sh, config.env, data/)
```

## Quick start (local)

Requires Node 22 or newer (its `node:sqlite` module stores the durable session) and Python 3.

```bash
npm run setup          # install agent dependencies
npm start              # starts catalog-api on :9001 and Sentinel on :8000
open http://localhost:8000
```

In another terminal, break something and alert the agent:

```bash
./scripts/trigger-alert.sh --break script     # typo in run.sh, then POST a sample alert
./scripts/trigger-alert.sh --break config     # invalid APP_PORT → crash at boot
./scripts/trigger-alert.sh --break data       # truncated catalog.json → /health 503
./scripts/trigger-alert.sh --break crash      # kill -9 the service
./scripts/trigger-alert.sh                    # just send scripts/sample-alert.json
./scripts/trigger-alert.sh --payload scripts/sample-alertmanager.json
sample-app/break.sh reset                     # put everything back
```

You can skip the alert entirely. Within about 20 seconds the monitor notices the failing health check and opens the incident itself. The UI's **Simulate** menu does the same from the browser.

### Try it with several people

Open the UI in two browsers with different names.

- While the agent is working, send a *Steer* message such as "check config.env before restarting". It joins the run after the current tool round, and the agent acknowledges it by name.
- Send "hold, don't restart anything". The playbook escalates and stops. Claude follows the same instruction from the system prompt.
- Send a *Note*. It is visible to everyone and recorded in the transcript, but the agent never sees it.
- Press **Stop agent**. This calls `conversation.abort()` and the incident stays open for humans.

### See the durability

```bash
./scripts/trigger-alert.sh --break data; sleep 6; pkill -9 -f src/server.ts   # kill mid-incident
npm --prefix agent start                                                     # restart
```

The transcript shows the half-written message tagged *interrupted · retried*, followed by a *resumed from the last durable checkpoint* event. The agent then finishes the incident. A tool call cut off mid-flight is never blindly re-run: only tools declared `replay: "safe"` (the probes and the log reader) rerun. Any other tool returns an `interrupted` result to the model.

## Configuration

All settings are environment variables. On boxd they live in `/etc/sentinel.env`.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` / `HOST` | `8000` / `0.0.0.0` | HTTP and WebSocket listener. boxd proxies `https://<vm>.boxd.sh` to port 8000. |
| `ANTHROPIC_API_KEY` | (empty) | When set, Claude drives the agent. When empty, the offline playbook does. |
| `SRE_MODEL` | `claude-sonnet-5-5` | Anthropic model id, for example `claude-opus-5-5`. |
| `SRE_ACCESS_TOKEN` | (empty) | Shared secret for the UI, WebSocket and webhook (`Authorization: Bearer …`). **Set this on any public URL**: the agent has a shell. |
| `SRE_WORKDIR` | `./sample-app` | Directory the agent's tools work in. Writes are confined to it. |
| `SRE_HEALTH_URL` | `http://127.0.0.1:9001/health` | Endpoint the monitor probes. |
| `SRE_MONITOR` / `SRE_MONITOR_INTERVAL_MS` / `SRE_MONITOR_THRESHOLD` | `1` / `10000` / `2` | Monitor switch, probe interval, and how many consecutive failures open an incident. |
| `SRE_CORRELATION_WINDOW_MS` | `1800000` | A new alert for a service that already has an open incident from inside this window joins that incident instead of starting a second agent. |
| `SRE_MAX_TURNS` | `40` | Upper bound on tool rounds per run, enforced by pi-durable. |
| `SRE_DATA_DIR` | `./.data` | Where `sentinel.sqlite` (the durable session) lives. |

## Deploy on boxd

```bash
curl -fsSL https://boxd.sh/install | sh && boxd login     # once
ANTHROPIC_API_KEY=sk-ant-... ./deploy/boxd-deploy.sh     # BOXD_VM=sentinel by default
```

The script does the following:

1. Runs `boxd new sentinel` if the machine doesn't exist yet.
2. Streams the repo to it as a tarball, so the VM needs no git credentials.
3. Runs `deploy/setup.sh` on the VM. This installs Node 22, runs `npm ci`, writes `/etc/sentinel.env` with a generated `SRE_ACCESS_TOKEN`, and installs a `sentinel` systemd unit with `Restart=always`. A restart costs nothing because the session is durable.
4. Sets the HTTPS proxy to port 8000.
5. Prints the URL and the access token.

To trigger the agent on the VM from your laptop:

```bash
SENTINEL_URL=https://sentinel.boxd.sh SRE_ACCESS_TOKEN=<token> ./scripts/trigger-alert.sh --break script
```

`deploy/setup.sh` works on any Debian or Ubuntu host: `sudo -E bash deploy/setup.sh`. Logs: `journalctl -u sentinel -f`.

> The boxd CLI calls (`boxd new`, `boxd machine exec`, `boxd machine proxy set-port`) follow boxd's public docs, but this POC was not run against a live boxd account. If your CLI version doesn't accept stdin on `machine exec`, clone the repo on the VM and run `sudo -E bash deploy/setup.sh` there.

## HTTP API

| Method and path | Body | |
|---|---|---|
| `POST /api/alerts` | `{title, service, severity, description?, fingerprint?, labels?, id?}` or an Alertmanager webhook | Opens an incident, or joins an open one by fingerprint or service correlation. Returns `202`. |
| `POST /api/incidents/:id/messages` | `{author, text, mode: "steer"\|"note"}` | Operator message. |
| `POST /api/incidents/:id/stop` | `{author}` | Abort the agent's current run. |
| `POST /api/incidents/:id/status` | `{author, status: "resolved"\|"open"}` | Resolve or reopen by hand. |
| `GET /api/state` | | Incidents, health probes and the active model. |
| `POST /api/demo/fault` | `{scenario}` | Runs `sample-app/break.sh` (demo only). |
| `GET /ws` | | WebSocket used by the UI: `hello`, `subscribe`, `message`, `stop`, `status`, `typing`. |

## How pi-durable is used

| Concern | pi-durable feature |
|---|---|
| One incident, one transcript | `tx.createConversation({ ownership: { kind: "ownerless" } })` plus `configure()` for model, cwd and `maxTurns` |
| Incident board | A session-scoped document `sre.incidents` (`defineDoc`), committed atomically with the transcripts. Tools update it through `api.commit()`. |
| Alerts and operator messages | `conversation.submit({ type: "input", entry: { kind: "sre.alert" \| "sre.operator" } })`. `whenBusy: "steer"` joins a running run, and `requestId` makes webhook retries idempotent. |
| Notes and audit events | `submit({ type: "write" })`. The entry is appended straight away and never sent to the model. |
| Live UI | `conversation.watch()`, which carries entries plus `pi.live` (streamed text, tool output, retries, run failures) and `pi.usage`, fanned out over WebSocket |
| Crash recovery | `openNodeSqliteStorage()` and `harness.resume()`. Tools declare `replay: "safe"` only when rerunning them is harmless. |
| Guardrails | `hook(ToolTask, { beforeTool })` returns `{ block }` |
| Stop button | `conversation.abort()` |

## Layout

```
agent/
  src/server.ts       HTTP + WebSocket server, health monitor, auth
  src/runtime.ts      Harness setup, incident lifecycle, dedup/correlation, steering
  src/tools.ts        SRE tools, system prompt section, guardrails hook
  src/demo-brain.ts   Offline playbook model (pi-ai faux provider)
  src/view.ts         Transcript entries / pi.live → UI shape
  public/             The web UI (vanilla HTML/CSS/JS, no build step)
sample-app/           catalog-api (Python), run.sh process manager, break.sh fault injector
scripts/              trigger-alert.sh and sample payloads
deploy/               boxd-deploy.sh, setup.sh (Node + systemd)
```

## Limits of this POC

- The service, the agent and the tools run on one host, and the agent's shell runs as the service user. A real deployment would run tools in a separate sandbox, for example a pi-env `RemoteExecutionEnv` or a dedicated boxd VM per incident.
- Auth is a single shared token. Names are self-declared, which is enough for a war room and not enough for an audit trail.
- The offline playbook only knows the four injected faults. Claude handles anything else within the guardrails.
- pi-durable is marked experimental, and its API changes between releases. Versions are pinned in `agent/package-lock.json`.
