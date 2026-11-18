#!/usr/bin/env python3
"""Catalog API: a tiny service the SRE agent looks after.

Reads its settings from config.env (next to this file), serves:
  GET /         -> service banner
  GET /health   -> 200 when the catalog data loads, 503 otherwise
  GET /items    -> the catalog
"""
import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))


def load_config():
    cfg = {}
    with open(os.path.join(HERE, "config.env")) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            cfg[key.strip()] = value.strip()
    return cfg


CONFIG = load_config()
PORT = int(CONFIG["APP_PORT"])  # a bad value here crashes the service at boot
DATA_FILE = os.path.join(HERE, CONFIG.get("DATA_FILE", "data/catalog.json"))
STARTED = time.time()


def log(msg):
    print(f"{time.strftime('%Y-%m-%dT%H:%M:%S')} catalog-api {msg}", flush=True)


def load_catalog():
    with open(DATA_FILE) as f:
        return json.load(f)


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body):
        payload = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        if self.path == "/health":
            try:
                items = load_catalog()["items"]
                self._send(200, {"status": "ok", "items": len(items), "uptime_s": round(time.time() - STARTED)})
            except Exception as e:  # noqa: BLE001
                log(f"ERROR health check failed: {type(e).__name__}: {e}")
                self._send(503, {"status": "degraded", "error": f"{type(e).__name__}: {e}"})
        elif self.path == "/items":
            try:
                self._send(200, load_catalog())
            except Exception as e:  # noqa: BLE001
                log(f"ERROR /items failed: {type(e).__name__}: {e}")
                self._send(500, {"error": str(e)})
        else:
            self._send(200, {"service": "catalog-api", "version": CONFIG.get("APP_VERSION", "dev")})

    def log_message(self, fmt, *args):
        if "/health" not in (args[0] if args else ""):
            log(fmt % args)


if __name__ == "__main__":
    log(f"starting on port {PORT}, data={DATA_FILE}")
    try:
        load_catalog()
    except Exception as e:  # noqa: BLE001
        log(f"WARN catalog not loadable at boot: {type(e).__name__}: {e}")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
