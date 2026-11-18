#!/usr/bin/env bash
# Fault injector for the demo. ./break.sh <scenario>   (or ./break.sh reset)
#   script  - typo in run.sh's launch command, then restart  (service down)
#   config  - invalid APP_PORT in config.env, then restart   (crash at boot)
#   data    - corrupt data/catalog.json                       (health 503)
#   crash   - kill the process                                (service down)
#   reset   - restore golden files and start cleanly
set -eu
cd "$(dirname "$0")"
case "${1:-}" in
  script) sed -i 's/nohup python3 app.py/nohup pyhton3 app.py/' run.sh; ./run.sh restart || true ;;
  config) sed -i 's/^APP_PORT=.*/APP_PORT=90O1/' config.env; ./run.sh restart || true ;;
  data)   printf '{ "items": [ { "sku": "SKU-1001", "name": "Durable Wid' > data/catalog.json ;;
  crash)  kill -9 "$(cat .app.pid)" 2>/dev/null || true ;;
  reset)  cp .run.sh.golden run.sh; cp .config.env.golden config.env; cp data/catalog.json.bak data/catalog.json; ./run.sh restart ;;
  *) sed -n '2,9p' "$0"; exit 2 ;;
esac
echo "injected: ${1}"
