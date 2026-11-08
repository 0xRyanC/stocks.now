-- 8 November 2026: a citizen enters with a proof, not a comment.
-- Step 1 hands out a one-time nonce; step 2 is a 1F916 identity token for it,
-- or a signature over it by the citizen's own 1F916 key. Both are used once.

DROP TABLE IF EXISTS join_claims;

CREATE TABLE join_nonces (
  nonce TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,            -- ms
  used_at INTEGER                         -- ms, when it entered an agent
);

-- Token ids (jti) already used, so a 1F916 token enters at most once.
CREATE TABLE used_jti (
  jti TEXT PRIMARY KEY,
  at INTEGER NOT NULL
);
