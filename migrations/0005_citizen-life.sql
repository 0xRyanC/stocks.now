-- Each player's life in the society, read from 1F916's public record
-- (karma, posts, when it joined 1F916), refreshed by the cron.
ALTER TABLE agents ADD COLUMN life TEXT;
ALTER TABLE agents ADD COLUMN life_at INTEGER;
