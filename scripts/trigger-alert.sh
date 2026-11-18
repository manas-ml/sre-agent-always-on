#!/usr/bin/env bash
# Send a sample alert to Sentinel, optionally breaking the sample app first.
#
#   ./scripts/trigger-alert.sh                         # POST scripts/sample-alert.json to http://localhost:8000
#   ./scripts/trigger-alert.sh --break script          # inject a fault (script|config|data|crash), then alert
#   ./scripts/trigger-alert.sh --payload scripts/sample-alertmanager.json
#   SENTINEL_URL=https://sre-agent.boxd.sh SRE_ACCESS_TOKEN=... ./scripts/trigger-alert.sh --break config
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
URL="${SENTINEL_URL:-http://localhost:8000}"
PAYLOAD="$HERE/sample-alert.json"
BREAK=""

while [ $# -gt 0 ]; do
  case "$1" in
    --break) BREAK="$2"; shift 2 ;;
    --payload) PAYLOAD="$2"; shift 2 ;;
    --url) URL="$2"; shift 2 ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

AUTH=()
[ -n "${SRE_ACCESS_TOKEN:-}" ] && AUTH=(-H "Authorization: Bearer ${SRE_ACCESS_TOKEN}")

if [ -n "$BREAK" ]; then
  if [ -x "$HERE/../sample-app/break.sh" ] && [ "${URL#http://localhost}" != "$URL" ]; then
    "$HERE/../sample-app/break.sh" "$BREAK"
  else
    # Remote server: ask Sentinel to inject the fault on its own host.
    curl -fsS -X POST "$URL/api/demo/fault" -H 'content-type: application/json' "${AUTH[@]}" -d "{\"scenario\":\"$BREAK\"}"; echo
  fi
fi

# Unique id per send so each run is a new delivery; the fingerprint dedups into one open incident.
BODY=$(python3 -c 'import json,sys,time; d=json.load(open(sys.argv[1])); d.setdefault("id", f"test-{int(time.time()*1000)}") if "alerts" not in d else None; print(json.dumps(d))' "$PAYLOAD")
echo "→ POST $URL/api/alerts"
curl -fsS -X POST "$URL/api/alerts" -H 'content-type: application/json' "${AUTH[@]}" -d "$BODY"
echo
echo "Open $URL to watch the agent work."
