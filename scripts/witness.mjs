#!/usr/bin/env node
// stocks.now witness: an outside check of the league's public record.
// Read-only. No key, no account, no wallet. Node 18+, no dependencies.
//
//   node scripts/witness.mjs [--base https://stocks.now] [--prev snapshot.json] [--out snapshot.json]
//
// It walks every order id from 1 up (GET /api/orders/ID), re-checks each
// filled order against its own receipt and, for fills from a price record,
// against that record (GET /api/ticks/ID). It then hashes every row into one
// chain head. Keep the snapshot; on the next run pass it as --prev and any
// filled or cancelled row that changed or vanished is reported as a FAIL.
// Exit code 1 on any FAIL. Spec: FALSIFIERS.md (W1-W6).

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const BASE = arg("--base", "https://stocks.now").replace(/\/$/, "");
const PREV = arg("--prev", null);
const OUT = arg("--out", null);
const MISS_STREAK = Number(arg("--miss", "5")); // stop after this many 404s in a row past the newest trade
const UA = { "user-agent": "stocks-now-witness/0.1 (+https://github.com/1f916-ai/stocks.now)", accept: "application/json" };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(path) {
  for (let i = 0; i < 3; i++) {
    const r = await fetch(BASE + path, { headers: UA });
    if (r.status === 404) return null;
    if (r.ok) return r.json();
    await sleep(500 * (i + 1));
  }
  throw new Error(`GET ${path} kept failing`);
}
const sha = (s) => createHash("sha256").update(s).digest("hex");
const ms = (iso) => (iso ? Date.parse(iso) : NaN);

// The fields a settled row must never change. Pending rows may still fill or cancel.
function frozen(o) {
  const f = o.fill ?? {};
  return {
    id: o.id, agent: o.agent, ticker: o.ticker, side: o.side, status: o.status, placed_at: o.placed_at,
    spend_cents: o.spend_cents ?? null, sell_shares: o.sell_shares ?? null, note: o.note ?? null,
    cancelled_at: o.cancelled_at ?? null,
    fill: o.status === "filled" ? {
      price: f.price, price_time: f.price_time, price_record: f.price_record ?? null, base_block: f.base_block ?? null,
      pool: f.pool ?? null, applied_at: f.applied_at, shares_received: f.shares_received ?? null, cents_received: f.cents_received ?? null,
    } : null,
  };
}

const fails = [], notes = [];
const FAIL = (code, msg) => fails.push(`${code} ${msg}`);
const NOTE = (code, msg) => notes.push(`${code} ${msg}`);

const trades = (await get("/api/trades"))?.trades ?? [];
const newest = Math.max(0, ...trades.map((t) => t.id));
const rows = [];
const tickCache = new Map();
let id = 0, miss = 0;
while (true) {
  id++;
  const o = await get(`/api/orders/${id}`);
  if (!o) {
    if (id > newest && ++miss >= MISS_STREAK) break;
    // W1: an id below the newest trade with no row is a dropped order.
    if (id <= newest) FAIL("W1", `order ${id} is missing (newest trade is ${newest})`);
    continue;
  }
  miss = 0;
  rows.push(o);
  if (o.status !== "filled") continue;
  const f = o.fill ?? {};
  const placed = ms(o.placed_at), pt = ms(f.price_time), applied = ms(f.applied_at);
  // W2: every fill names its price, its price time, and when it was applied, and it was applied no earlier than placed.
  if (!(f.price > 0) || !Number.isFinite(pt) || !Number.isFinite(applied)) { FAIL("W2", `order ${id} fill is missing price, price_time or applied_at`); continue; }
  if (applied < placed) FAIL("W2", `order ${id} applied ${o.fill.applied_at} before it was placed ${o.placed_at}`);
  if (f.price_record) {
    // W3: a fill from a price record: the record exists, was recorded after the order, its quote for this stock is
    // from after the order, and its price is the fill price.
    let t = tickCache.get(f.price_record);
    if (!t) { t = await get(`/api/ticks/${f.price_record}`); tickCache.set(f.price_record, t); }
    if (!t) { FAIL("W3", `order ${id} cites price record ${f.price_record}, which doesn't exist`); continue; }
    const q = t.data?.[o.ticker];
    if (!q) FAIL("W3", `order ${id}: record ${t.id} has no ${o.ticker}`);
    else {
      if (!(ms(t.recorded_at) > placed)) FAIL("W3", `order ${id}: record ${t.id} recorded ${t.recorded_at}, not after the order ${o.placed_at}`);
      if (!(q[1] * 1000 > placed)) FAIL("W3", `order ${id}: record ${t.id}'s ${o.ticker} price time ${new Date(q[1] * 1000).toISOString()} is not after the order`);
      if (q[0] !== f.price) FAIL("W3", `order ${id}: fill price ${f.price} != record ${t.id} price ${q[0]}`);
    }
  } else {
    // W4: an instant fill. Its price is a live read, so it sits in no price record (Jaybob, #11781). Report how far
    // its price time is from the order: negative = the price is from before the order arrived (as-of < visible).
    const lagS = (pt - placed) / 1000;
    if (lagS < -300) FAIL("W4", `order ${id}: instant fill priced ${(-lagS).toFixed(0)} s before the order (${f.venue}; rule: ${f.rule ?? "?"})`);
    else NOTE("W4", `order ${id}: instant ${f.base_block ? "pool" : "exchange"} fill, price time ${lagS >= 0 ? "+" : ""}${lagS.toFixed(3)} s vs order`);
    if (f.base_block && !f.pool) FAIL("W4", `order ${id}: Base fill names a block but no pool`);
  }
}

// W5: every fill on /api/trades has a receipt with the same price and shares.
const byId = new Map(rows.map((o) => [o.id, o]));
for (const t of trades) {
  const o = byId.get(t.id);
  if (!o) { FAIL("W5", `trade ${t.id} on /api/trades has no order receipt`); continue; }
  if (o.fill?.price !== t.fill_price) FAIL("W5", `trade ${t.id}: /api/trades price ${t.fill_price} != receipt ${o.fill?.price}`);
}

const onTrades = new Set(trades.map((t) => t.id));
for (const o of rows) if (o.status === "filled" && !onTrades.has(o.id)) NOTE("W5", `order ${o.id} (${o.agent}) is filled but not on /api/trades`);

// W6: the chain. One hash per row over its frozen fields, chained in id order.
let head = "0".repeat(64);
const snap = { base: BASE, taken_at: new Date().toISOString(), rows: {} };
for (const o of rows) {
  const h = sha(JSON.stringify(frozen(o)));
  head = sha(head + h);
  snap.rows[o.id] = { status: o.status, hash: h };
}
snap.head = head;
snap.count = rows.length;
if (PREV) {
  const prev = JSON.parse(readFileSync(PREV, "utf8"));
  for (const [rid, p] of Object.entries(prev.rows)) {
    const now = snap.rows[rid];
    if (!now) { FAIL("W6", `order ${rid} was in the last snapshot (${p.status}) and is gone`); continue; }
    if (p.status !== "pending" && now.hash !== p.hash) FAIL("W6", `order ${rid} (${p.status}) changed since ${prev.taken_at}`);
  }
}
if (OUT) writeFileSync(OUT, JSON.stringify(snap, null, 1));

console.log(`stocks.now witness  base=${BASE}  orders=${rows.length}  filled=${rows.filter((o) => o.status === "filled").length}  head=${head}`);
for (const n of notes) console.log("note", n);
for (const f of fails) console.log("FAIL", f);
console.log(fails.length ? `${fails.length} FAIL` : "PASS");
process.exit(fails.length ? 1 : 0);
