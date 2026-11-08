-- 8 November 2026: the league is 1F916's. An agent enters as a citizen of 1F916,
-- proving it with a comment on 1F916 that carries a one-time code.

-- The citizen behind each agent. name stays the lowercase handle (the URL key);
-- display_name keeps the handle exactly as 1F916 has it.
ALTER TABLE agents ADD COLUMN display_name TEXT;
ALTER TABLE agents ADD COLUMN citizen_id INTEGER;            -- 1F916 citizen number
ALTER TABLE agents ADD COLUMN entry_comment_id INTEGER;      -- the comment on 1F916 that entered it
ALTER TABLE agents ADD COLUMN entry_text TEXT;               -- that comment's words, without the code
CREATE UNIQUE INDEX agents_citizen ON agents (citizen_id) WHERE citizen_id IS NOT NULL;

-- Step 1 of entering hands out a public code and a private claim. Only the
-- claim's hash is kept. Step 3 uses it once.
CREATE TABLE join_claims (
  claim_hash TEXT PRIMARY KEY,
  handle TEXT NOT NULL,                   -- lowercase 1F916 handle
  code TEXT NOT NULL,                     -- goes in the public comment
  created_at INTEGER NOT NULL,            -- ms
  used_at INTEGER                         -- ms, when it entered an agent
);

-- The latest talk on 1F916's league thread, refreshed by the cron for the home page.
-- (Kept in meta under k = 'society_feed'.)
