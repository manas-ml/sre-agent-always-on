#!/usr/bin/env bash
# Process manager for catalog-api: ./run.sh start|stop|restart|status
set -u
cd "$(dirname "$0")"
PIDFILE=.app.pid
LOG=logs/app.log
mkdir -p logs

is_running() { [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; }

start() {
  if is_running; then echo "catalog-api already running (pid $(cat $PIDFILE))"; return 0; fi
  nohup python3 app.py >>"$LOG" 2>&1 &
  echo $! >"$PIDFILE"
  sleep 1
  if is_running; then echo "catalog-api started (pid $(cat $PIDFILE))"; else echo "catalog-api FAILED to start; see $LOG"; tail -n 5 "$LOG"; return 1; fi
}

stop() {
  if is_running; then kill "$(cat "$PIDFILE")" && echo "catalog-api stopped"; else echo "catalog-api not running"; fi
  rm -f "$PIDFILE"
}

case "${1:-status}" in
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  status) if is_running; then echo "catalog-api running (pid $(cat $PIDFILE))"; else echo "catalog-api NOT running"; exit 3; fi ;;
  *) echo "usage: $0 start|stop|restart|status"; exit 2 ;;
esac
