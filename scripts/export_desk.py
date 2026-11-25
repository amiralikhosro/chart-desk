#!/usr/bin/env python3
"""Run trade_desk for Chart Desk watchlist coins and publish desk-latest.json.

Writes long/short WAIT triggers (or APPROVED entry/stop/target) that Chart Desk draws.

Usage (from kronos root):
  .venv/bin/python chart-desk/scripts/export_desk.py
  .venv/bin/python chart-desk/scripts/export_desk.py --push http://127.0.0.1:4173
  .venv/bin/python chart-desk/scripts/export_desk.py --out chart-desk/data/desk-latest.json
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DESK = ROOT / "chart-desk"
DEFAULT_OUT = DESK / "data" / "desk-latest.json"
COINS = ["GOLD", "BTC", "SOL", "XLM"]

HL_CHART = {
    "GOLD": "hyperliquid:xyz:GOLD",
    "BTC": "hyperliquid:BTC",
    "SOL": "hyperliquid:SOL",
    "XLM": "hyperliquid:XLM",
}


def run_coin(coin: str) -> dict | None:
    py = ROOT / ".venv" / "bin" / "python"
    cmd = [str(py if py.exists() else sys.executable), str(ROOT / "trade_desk.py"), coin]
    proc = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=600)
    out = (proc.stdout or "") + "\n" + (proc.stderr or "")
    line = next((ln for ln in out.splitlines() if ln.startswith("DESK_JSON ")), None)
    if not line:
        print(f"[export_desk] no DESK_JSON for {coin}", file=sys.stderr)
        if proc.returncode:
            print(proc.stderr[-800:], file=sys.stderr)
        return None
    return json.loads(line[len("DESK_JSON ") :])


def to_plan(p: dict | None, fallback_entry: float) -> dict:
    p = p or {}
    entry = float(p.get("entry", fallback_entry))
    return {
        "entry": entry,
        "stop": float(p.get("stop", entry)),
        "target": float(p.get("target", entry)),
        "replay": float(p.get("replay", 0)),
    }


def convert(raw: dict) -> dict:
    coin = str(raw["coin"]).upper()
    side = int(raw.get("side") or 0)
    verdict = str(raw.get("verdict") or "WAIT")
    if verdict == "APPROVED":
        verdict = "APPROVED LONG" if side > 0 else "APPROVED SHORT"
    elif verdict.startswith("NOT"):
        # Still publish triggers so the chart shows levels
        verdict = "WAIT"

    plans_in = raw.get("plans") or {}
    long_raw = plans_in.get("1") or plans_in.get(1) or plans_in.get("long")
    short_raw = plans_in.get("-1") or plans_in.get(-1) or plans_in.get("short")
    hi = float(raw["high_24h"])
    lo = float(raw["low_24h"])

    return {
        "coin": coin if coin != "GOLD" else "GOLD",
        "chartSymbol": HL_CHART.get(coin, f"hyperliquid:{coin}"),
        "verdict": verdict,
        "close": float(raw["close"]),
        "high_24h": hi,
        "low_24h": lo,
        "plans": {
            "long": to_plan(long_raw, hi),
            "short": to_plan(short_raw, lo),
        },
    }


def push(url: str, payload: dict, token: str = "") -> None:
    import urllib.request

    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url.rstrip("/") + "/desk-latest.json",
        data=body,
        method="PUT",
        headers={"Content-Type": "application/json", **({"X-Desk-Token": token} if token else {})},
    )
    with urllib.request.urlopen(req, timeout=30) as res:
        print("[export_desk] pushed", res.status, res.read().decode()[:200])


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--push", metavar="URL", help="PUT to Chart Desk server (e.g. http://127.0.0.1:4173)")
    ap.add_argument("--token", default="", help="DESK_TOKEN if the server requires it")
    ap.add_argument("--coins", nargs="+", default=COINS)
    args = ap.parse_args()

    markets = []
    for coin in args.coins:
        print(f"[export_desk] running trade_desk {coin} …", flush=True)
        raw = run_coin(coin)
        if not raw:
            continue
        markets.append(convert(raw))
        print(f"[export_desk] {coin}: {markets[-1]['verdict']}", flush=True)

    if not markets:
        print("[export_desk] nothing to write", file=sys.stderr)
        return 1

    payload = {
        "at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "note": "Paper only. Exported from trade_desk for Chart Desk long/short lines.",
        "markets": markets,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(payload, indent=2) + "\n")
    print(f"[export_desk] wrote {args.out}")

    # Keep public/ in sync for next docker rebuild
    pub = DESK / "public" / "desk-latest.json"
    pub.write_text(json.dumps(payload, indent=2) + "\n")

    if args.push:
        try:
            push(args.push, payload, args.token)
        except Exception as err:
            print(f"[export_desk] push failed ({args.push}): {err}", file=sys.stderr)
            # File on disk is still fresh — Docker volume / next rebuild can pick it up
            return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
