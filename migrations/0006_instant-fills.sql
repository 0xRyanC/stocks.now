-- Instant fills: an order filled when it arrives keeps where its price came from,
-- since no price record (tick) holds it. Fills from a price record leave these empty.
ALTER TABLE orders ADD COLUMN fill_venue TEXT;   -- b = the token's pool on Base, x = the US exchange
ALTER TABLE orders ADD COLUMN fill_block INTEGER; -- the Base block a pool price was read at
ALTER TABLE orders ADD COLUMN fill_how TEXT;     -- pool | exchange (in session) | close (market shut)
