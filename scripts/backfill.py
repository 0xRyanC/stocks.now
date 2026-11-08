#!/usr/bin/env python3
"""Backfill a year of daily closes for the 71 stocks into the `daily` table.

Reads Yahoo Finance's public chart endpoint once per stock, writes
scripts/out/backfill.sql, and prints the wrangler command to load it:

    python3 scripts/backfill.py
    npx wrangler d1 execute stocks-now --remote --file scripts/out/backfill.sql

Run it from a normal computer, not from the Worker: it is a one-time job.
"""
import json, os, re, sys, time, urllib.request
from datetime import datetime, timezone, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
stocks_ts = open(os.path.join(HERE, "..", "src", "stocks.ts")).read()
TICKERS = re.findall(r'ticker: "([A-Z]+)"', stocks_ts)
assert len(TICKERS) == 71, len(TICKERS)
UA = "Mozilla/5.0 (compatible; stocks-now-league/1.0; +https://stocks.now)"
NY = timezone(timedelta(hours=-5))  # day boundary only; closes are stamped ~16:00 NY

rows = []
for t in TICKERS:
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{t}?range=1y&interval=1d"
    for attempt in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=30) as r:
                j = json.load(r)
            break
        except Exception as e:
            if attempt == 2:
                print(f"{t}: failed ({e})", file=sys.stderr)
                j = None
            time.sleep(2 + attempt * 3)
    if not j:
        continue
    res = j["chart"]["result"][0]
    ts = res.get("timestamp") or []
    closes = res["indicators"]["quote"][0].get("close") or []
    n = 0
    for s, c in zip(ts, closes):
        if c is None or c <= 0:
            continue
        day = datetime.fromtimestamp(s, NY).strftime("%Y-%m-%d")
        rows.append((t, day, round(float(c), 6)))
        n += 1
    print(f"{t}: {n} days", file=sys.stderr)
    time.sleep(0.4)

os.makedirs(os.path.join(HERE, "out"), exist_ok=True)
out = os.path.join(HERE, "out", "backfill.sql")
with open(out, "w") as f:
    for i in range(0, len(rows), 200):
        chunk = rows[i:i + 200]
        vals = ",".join(f"('{t}','{d}',{c})" for t, d, c in chunk)
        f.write(f"INSERT INTO daily (ticker, day, close) VALUES {vals} ON CONFLICT (ticker, day) DO UPDATE SET close = excluded.close;\n")
print(f"{len(rows)} rows -> {out}")
