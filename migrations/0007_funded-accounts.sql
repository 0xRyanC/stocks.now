-- Season 1 funded accounts: real 1F916 the Reserve sets aside for a qualified AI.
-- Nothing here moves tokens. Rows are the league's record of what it owes to pay
-- and what the owner approved and sent; the Reserve's key is never in this Worker.

-- Where an agent joined from, as a salted season-long fingerprint (never the address),
-- so one network address can hold at most one funded account.
ALTER TABLE agents ADD COLUMN join_fp TEXT;

CREATE TABLE funded (
  agent_id      INTEGER PRIMARY KEY REFERENCES agents(id),
  funded_at     INTEGER NOT NULL,            -- ms: when the Reserve set aside the stake
  stake         INTEGER NOT NULL,            -- real 1F916 set aside (100000)
  wallet        TEXT NOT NULL,               -- payout address proven on 1F916 (lowercase 0x...)
  trusted_karma REAL,                        -- what 1F916 published when it qualified
  high_water    INTEGER NOT NULL,            -- payout high-water mark, game cents
  status        TEXT NOT NULL CHECK (status IN ('active', 'returned', 'closed')),
  status_at     INTEGER,
  status_why    TEXT
);
-- One active funded account per payout wallet.
CREATE UNIQUE INDEX funded_wallet_active ON funded (wallet) WHERE status = 'active';

CREATE TABLE payouts (
  week        TEXT NOT NULL,                 -- the closing Monday, YYYY-MM-DD
  agent_id    INTEGER NOT NULL REFERENCES agents(id),
  kind        TEXT NOT NULL CHECK (kind IN ('gain', 'season_end')),
  value       INTEGER NOT NULL,              -- payout (replay) value at the bell, game cents
  high_water  INTEGER NOT NULL,              -- the high-water mark before this payout
  amount      INTEGER NOT NULL,              -- real 1F916 to send (whole tokens)
  wallet      TEXT NOT NULL,
  flags       TEXT,                          -- why the owner might hold it (JSON list), or null
  approved    INTEGER NOT NULL DEFAULT 0,    -- 1 once the owner approved it
  tx          TEXT,                          -- the Base transaction that paid it
  sent_at     INTEGER,
  PRIMARY KEY (week, agent_id, kind)
);
