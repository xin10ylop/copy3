-- Repairs rows written before the jsonb double-encoding fix in createDb (jsonb columns that
-- hold a JSON *string* containing JSON). Idempotent: only rows whose top-level jsonb type is
-- 'string' and whose content parses as JSON are rewritten.
CREATE OR REPLACE FUNCTION hood_unwrap_json(v jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF v IS NULL OR jsonb_typeof(v) <> 'string' THEN RETURN v; END IF;
  BEGIN
    RETURN (v #>> '{}')::jsonb;
  EXCEPTION WHEN others THEN
    RETURN v;
  END;
END $$;
UPDATE plays SET trigger = hood_unwrap_json(trigger), preset = hood_unwrap_json(preset), stats = hood_unwrap_json(stats)
  WHERE jsonb_typeof(trigger) = 'string' OR jsonb_typeof(preset) = 'string' OR jsonb_typeof(stats) = 'string';
UPDATE settings SET value = hood_unwrap_json(value) WHERE jsonb_typeof(value) = 'string';
UPDATE events SET payload = hood_unwrap_json(payload) WHERE jsonb_typeof(payload) = 'string';
UPDATE snipes SET decision = hood_unwrap_json(decision), burst = hood_unwrap_json(burst), sells = hood_unwrap_json(sells)
  WHERE jsonb_typeof(decision) = 'string' OR jsonb_typeof(burst) = 'string' OR jsonb_typeof(sells) = 'string';
UPDATE wallets SET labels = hood_unwrap_json(labels) WHERE jsonb_typeof(labels) = 'string';
UPDATE agent_runs SET input = hood_unwrap_json(input), proposed_play = hood_unwrap_json(proposed_play)
  WHERE jsonb_typeof(input) = 'string' OR jsonb_typeof(proposed_play) = 'string';
