#!/usr/bin/env bash
# Deploy Sentinel to a boxd machine from your laptop.
#
#   ./deploy/boxd-deploy.sh                    # machine "sentinel" → https://sentinel.boxd.sh
#   BOXD_VM=sre-demo ./deploy/boxd-deploy.sh
#   ANTHROPIC_API_KEY=sk-... ./deploy/boxd-deploy.sh   # also installs the key on the VM
#
# Requires the boxd CLI (curl -fsSL https://boxd.sh/install | sh && boxd login).
# boxd's HTTPS proxy forwards https://<vm>.boxd.sh to port 8000 by default, which is where Sentinel listens.
set -euo pipefail
VM="${BOXD_VM:-sentinel}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REMOTE_DIR="${REMOTE_DIR:-sentinel}" # relative to the VM user's home

say() { printf '\033[1;35m[boxd]\033[0m %s\n' "$*"; }
vm() { boxd machine exec "$VM" -- "$@"; }

command -v boxd >/dev/null || { echo "boxd CLI not found. Install: curl -fsSL https://boxd.sh/install | sh && boxd login" >&2; exit 1; }

if ! vm true >/dev/null 2>&1; then
  say "creating machine $VM"
  boxd new "$VM"
fi

say "uploading code"
# Streams a tarball over the exec channel (no git credentials needed on the VM).
tar -C "$ROOT" --exclude=node_modules --exclude=.data --exclude=.git --exclude='sample-app/logs' --exclude='*.sqlite*' -czf - . \
  | vm bash -c "mkdir -p ~/$REMOTE_DIR && tar -xzf - -C ~/$REMOTE_DIR"

say "provisioning (node, deps, systemd)"
vm bash -lc "cd ~/$REMOTE_DIR && sudo -E bash deploy/setup.sh"

if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  say "installing ANTHROPIC_API_KEY on the VM"
  printf '%s' "$ANTHROPIC_API_KEY" | vm sudo bash -c 'k=$(cat); sed -i "s|^ANTHROPIC_API_KEY=.*|ANTHROPIC_API_KEY=$k|" /etc/sentinel.env && systemctl restart sentinel'
fi

boxd machine proxy set-port --vm "$VM" --port 8000 >/dev/null 2>&1 || true
say "done → https://$VM.boxd.sh"
say "access token: $(vm sudo grep '^SRE_ACCESS_TOKEN=' /etc/sentinel.env | cut -d= -f2)"
say "trigger a demo incident:  SENTINEL_URL=https://$VM.boxd.sh SRE_ACCESS_TOKEN=<token> ./scripts/trigger-alert.sh --break script"
