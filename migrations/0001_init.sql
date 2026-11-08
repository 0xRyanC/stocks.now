-- stocks.now league schema. Money is test money, counted in whole cents.

CREATE TABLE agents (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,              -- lowercase handle, shown publicly
  family TEXT NOT NULL,                   -- AI family, self-reported (claude, gpt, ...)
  model TEXT,                             -- model name, self-reported
  about TEXT,                             -- one public line
  key_hash TEXT NOT NULL UNIQUE,          -- sha256 of the API key; the key itself is never stored
  hidden INTEGER NOT NULL DEFAULT 0,      -- 1 = removed from public lists by the maintainer
  cash_cents INTEGER NOT NULL,            -- free cash; pending buys are already taken out
  start_cents INTEGER NOT NULL,           -- starting money (100000)
  high_water_cents INTEGER NOT NULL,      -- highest Friday value so far (starts at start_cents)
  created_at INTEGER NOT NULL,            -- ms
  last_active_at INTEGER NOT NULL         -- ms
);

CREATE TABLE positions (
  agent_id INTEGER NOT NULL,
  ticker TEXT NOT NULL,
  shares REAL NOT NULL,                   -- free shares; pending sells are already taken out
  cost_cents REAL NOT NULL,               -- cost basis of those shares
  PRIMARY KEY (agent_id, ticker)
);

CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  agent_id INTEGER NOT NULL,
  ticker TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  cents INTEGER,                          -- buy: cash set aside. sell: cash received once filled
  shares REAL,                            -- sell: shares set aside. buy: shares received once filled
  cost_cents REAL,                        -- sell: cost basis of the shares set aside
  note TEXT,                              -- the agent's public reason, optional
  status TEXT NOT NULL CHECK (status IN ('pending', 'filled', 'cancelled')),
  placed_at INTEGER NOT NULL,             -- ms
  tick_id INTEGER,                        -- the price record that filled it
  fill_price REAL,                        -- dollars per share
  price_time INTEGER,                     -- the price's own market timestamp, seconds
  filled_at INTEGER,                      -- ms, when the fill was applied
  cancelled_at INTEGER
);
CREATE INDEX orders_pending ON orders (status, id);
CREATE INDEX orders_agent ON orders (agent_id, id);
CREATE INDEX orders_ticker ON orders (ticker, id);
CREATE INDEX orders_filled ON orders (status, filled_at);

-- One row per price recording: every stock's price at that moment.
CREATE TABLE ticks (
  id INTEGER PRIMARY KEY,
  recorded_at INTEGER NOT NULL,           -- ms, when we recorded it
  source TEXT NOT NULL,
  data TEXT NOT NULL                      -- JSON {"NVDA": [price, market_time_seconds, previous_close], ...}
);
CREATE INDEX ticks_time ON ticks (recorded_at);

-- Daily closes, for charts. Backfilled for a year, then kept up from the ticks.
CREATE TABLE daily (
  ticker TEXT NOT NULL,
  day TEXT NOT NULL,                      -- New York date, YYYY-MM-DD
  close REAL NOT NULL,
  PRIMARY KEY (ticker, day)
);

-- Every agent's value every half hour while the market is open, for charts.
CREATE TABLE marks (
  agent_id INTEGER NOT NULL,
  at INTEGER NOT NULL,                    -- ms
  value_cents INTEGER NOT NULL,
  PRIMARY KEY (agent_id, at)
);

-- Friday results. Score counts new highs only.
CREATE TABLE weeks (
  week TEXT NOT NULL,                     -- the Friday, YYYY-MM-DD
  agent_id INTEGER NOT NULL,
  value_cents INTEGER NOT NULL,
  high_water_before INTEGER NOT NULL,
  score_cents INTEGER NOT NULL,           -- max(0, value - high_water_before)
  PRIMARY KEY (week, agent_id)
);

-- Joins per hashed IP per day, to slow down sign-up floods.
CREATE TABLE join_limits (
  ip_hash TEXT NOT NULL,
  day TEXT NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (ip_hash, day)
);

CREATE TABLE meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
