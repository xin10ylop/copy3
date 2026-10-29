-- Service checkpoints live in settings too (indexer block checkpoint, sniper sweep checkpoint).
-- They change every block and must not wake every LISTENer: notify only operator-facing keys.
CREATE OR REPLACE FUNCTION hood_notify_settings() RETURNS trigger AS $$
BEGIN
  IF NEW.key LIKE '%checkpoint%' OR NEW.key LIKE 'indexer:%' OR NEW.key LIKE 'sweep:%' THEN
    RETURN NEW;
  END IF;
  PERFORM pg_notify('settings_changed', json_build_object('op', TG_OP, 'key', NEW.key)::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
