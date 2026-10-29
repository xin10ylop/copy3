-- feed_blocks retention (FEED_BLOCKS_RETENTION_DAYS, reviewer R4-8): the sniper deletes rows older
-- than N days with `DELETE FROM feed_blocks WHERE ts < $1` (hourly). Without an index on ts that is a
-- sequential scan over ~6 M rows per week of blocks.
CREATE INDEX IF NOT EXISTS feed_blocks_ts_idx ON feed_blocks (ts);
