#!/usr/bin/env bash
# Provision Sentinel on a fresh Linux VM (a boxd machine or any Ubuntu/Debian host).
# Run from the repo checkout:  sudo -E bash deploy/setup.sh
# Idempotent: safe to re-run after pulling new code.
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RUN_AS="${SUDO_USER:-$(id -un)}"
ENV_FILE=/etc/sentinel.env
NODE_MAJOR=22

log() { printf '\033[1;35m[setup]\033[0m %s\n' "$*"; }

# 1. Runtime: Node.js 22+ (node:sqlite powers the durable session) and Python 3 for the sample app.
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt "$NODE_MAJOR" ]; then
  log "installing Node.js $NODE_MAJOR"
  apt-get update -y
  apt-get install -y ca-certificates curl gnupg
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" -o /tmp/nodesource_setup.sh
  bash /tmp/nodesource_setup.sh
  apt-get install -y nodejs
fi
command -v python3 >/dev/null || { log "installing python3"; apt-get install -y python3; }
log "node $(node -v), $(python3 --version)"

# 2. Dependencies.
log "installing agent dependencies"
sudo -u "$RUN_AS" bash -c "cd '$APP_DIR/agent' && npm ci --no-audit --no-fund"

# 3. Configuration (secrets live here, never in the repo).
if [ ! -f "$ENV_FILE" ]; then
  log "writing $ENV_FILE (edit it to add ANTHROPIC_API_KEY / SRE_ACCESS_TOKEN)"
  cat >"$ENV_FILE" <<CONF
# Sentinel configuration. Restart after editing: sudo systemctl restart sentinel
PORT=8000
HOST=0.0.0.0
SRE_DATA_DIR=$APP_DIR/.data
SRE_WORKDIR=$APP_DIR/sample-app
SRE_HEALTH_URL=http://127.0.0.1:9001/health
# Set to use Claude; leave empty for the offline demo playbook.
ANTHROPIC_API_KEY=
SRE_MODEL=claude-sonnet-5-5
# Strongly recommended on a public URL: shared token for the UI, websocket and webhook.
SRE_ACCESS_TOKEN=$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)
CONF
  chmod 600 "$ENV_FILE"
fi

# 4. systemd: Sentinel itself is supervised; the sample app is started by run.sh so the agent can manage it.
log "installing systemd unit"
cat >/etc/systemd/system/sentinel.service <<UNIT
[Unit]
Description=Sentinel always-on SRE agent (pi-durable)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_AS
WorkingDirectory=$APP_DIR/agent
EnvironmentFile=$ENV_FILE
ExecStartPre=-/bin/bash $APP_DIR/sample-app/run.sh start
ExecStart=$APP_DIR/agent/node_modules/.bin/tsx src/server.ts
# Durable session: in-flight incidents resume after any restart.
Restart=always
RestartSec=2
KillSignal=SIGTERM
TimeoutStopSec=15

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable sentinel >/dev/null
systemctl restart sentinel

sleep 3
if curl -fsS http://127.0.0.1:8000/healthz >/dev/null; then
  log "Sentinel is up on :8000"
  grep -q '^SRE_ACCESS_TOKEN=.\+' "$ENV_FILE" && log "access token: $(grep '^SRE_ACCESS_TOKEN=' "$ENV_FILE" | cut -d= -f2)"
else
  log "Sentinel did not answer yet; check: journalctl -u sentinel -n 50"
fi
