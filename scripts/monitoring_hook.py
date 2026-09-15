#!/usr/bin/env python3
"""
Monitoring hook — IDLE component.

Reports significant application events to an external monitoring endpoint.

Stays idle by default:
  * MONITORING_ENABLED defaults to "false", so report() returns immediately
    and makes NO network call to any paid endpoint.
  * No credentials are required while idle: a missing or empty
    MONITORING_ENDPOINT never crashes startup or fails a healthcheck.

Activate by setting in the root .env:

    MONITORING_ENABLED=true
    MONITORING_ENDPOINT=https://your-monitoring-service.example/v1/events
    MONITORING_API_KEY=            # optional, only if the endpoint needs one

Wired into app.py as a no-op import + a single call from the existing
periodic-task error handler. When the module is unavailable (e.g. run outside
the repo layout) app.py falls back to a no-op, so startup never breaks.
"""

# IDLE — costs money when enabled. Set MONITORING_ENABLED=true in .env.

import json
import os
import sys
import urllib.request


def report(event, payload=None):
    """Send one event to the monitoring endpoint. No-op unless enabled."""
    enabled = os.getenv("MONITORING_ENABLED", "false").lower() == "true"
    if not enabled:
        print("monitoring idle — not configured")
        return

    endpoint = (os.getenv("MONITORING_ENDPOINT") or "").strip()
    if not endpoint:
        print("monitoring idle — MONITORING_ENDPOINT not set")
        return

    try:
        body = json.dumps({"event": str(event), "payload": payload or {}}).encode("utf-8")
        req = urllib.request.Request(endpoint, data=body, method="POST")
        req.add_header("Content-Type", "application/json")
        api_key = (os.getenv("MONITORING_API_KEY") or "").strip()
        if api_key:
            req.add_header("Authorization", f"Bearer {api_key}")
        with urllib.request.urlopen(req, timeout=10) as resp:
            if resp.status >= 400:
                # The event was delivered; a non-2xx is the endpoint's problem.
                print(f"monitoring: endpoint returned HTTP {resp.status}")
    except Exception as exc:
        # Never take the application down over a telemetry call.
        print(f"monitoring: report failed: {exc}")


if __name__ == "__main__":
    # Tiny sidecar agent used by the docker-compose "paid" profile. It only
    # does anything useful when MONITORING_ENABLED=true; otherwise it prints
    # the idle line and exits 0 (the profile is not started by default anyway).
    report("agent.heartbeat", {"component": "monitoring-agent", "python": sys.version.split()[0]})