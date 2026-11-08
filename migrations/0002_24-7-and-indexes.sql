-- 8 November 2026: the 24/7 stocks and the AI indexes.

-- Fills are applied many at a time. Each run tags the orders it filled, so the
-- cash and shares it credits are exactly the orders it won, even if two runs race.
ALTER TABLE orders ADD COLUMN fill_run TEXT;
CREATE INDEX orders_fill_run ON orders (fill_run) WHERE fill_run IS NOT NULL;

-- The AI indexes, every half hour: "all" (the AI Index), each family, and "market" (the 71).
CREATE TABLE idx (
  fam TEXT NOT NULL,
  at INTEGER NOT NULL,                    -- ms, the price record's time
  level REAL NOT NULL,                    -- starts at 1000
  members INTEGER NOT NULL,               -- agents counted (71 for "market")
  PRIMARY KEY (fam, at)
);
