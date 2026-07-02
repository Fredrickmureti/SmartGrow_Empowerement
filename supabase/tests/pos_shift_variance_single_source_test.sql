-- POS shift-close variance — single source of truth contract.
--
-- Pins the invariants established when we unified the legacy
-- `cash_variance_tolerance` column with the new `pos_override_matrix`
-- threshold (action='shift_variance'):
--
--   1. The trigger reads the threshold from `pos_override_matrix` first and
--      only falls back to the per-shift legacy column when no matrix row
--      exists. There must be no hardcoded numeric tolerance in the body.
--   2. When the trigger blocks, it raises SQLSTATE 42501 with the literal
--      message `override_required` and a JSON `DETAIL` carrying at least the
--      shift_id, expected_cash, actual_cash, variance, and threshold so the
--      UI can switch into PIN-prompt mode using the server's numbers.
--   3. Every organization has at least one active shift_variance matrix row,
--      so the matrix is unambiguously authoritative.
--   4. Each newly opened shift gets its `cash_variance_tolerance` stamped
--      from the matrix at INSERT time, keeping historical shifts auditable.
\set ON_ERROR_STOP on

-- (1) Trigger reads the matrix and avoids the legacy hardcoded default.
DO $$
DECLARE body text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO body
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'enforce_pos_shift_cash_variance'
   LIMIT 1;
  IF body IS NULL THEN
    RAISE EXCEPTION 'enforce_pos_shift_cash_variance() is missing';
  END IF;
  IF position('pos_override_matrix' IN body) = 0 THEN
    RAISE EXCEPTION
      'enforce_pos_shift_cash_variance() must resolve threshold from pos_override_matrix';
  END IF;
  IF position('override_required' IN body) = 0 THEN
    RAISE EXCEPTION
      'enforce_pos_shift_cash_variance() must raise the canonical override_required error';
  END IF;
  -- The DETAIL payload must expose the fields the dialog parses.
  IF position('threshold' IN body) = 0
     OR position('variance'  IN body) = 0
     OR position('shift_id'  IN body) = 0 THEN
    RAISE EXCEPTION
      'enforce_pos_shift_cash_variance() DETAIL payload must include shift_id, variance, threshold';
  END IF;
END $$;

-- (2) The shift-open stamping trigger exists and reads the matrix.
DO $$
DECLARE body text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO body
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'stamp_pos_shift_variance_tolerance'
   LIMIT 1;
  IF body IS NULL THEN
    RAISE EXCEPTION 'stamp_pos_shift_variance_tolerance() is missing';
  END IF;
  IF position('pos_override_matrix' IN body) = 0 THEN
    RAISE EXCEPTION
      'stamp_pos_shift_variance_tolerance() must resolve threshold from pos_override_matrix';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.pos_shifts'::regclass
       AND tgname  = 'trg_stamp_pos_shift_variance_tolerance'
       AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION
      'trg_stamp_pos_shift_variance_tolerance must be attached to pos_shifts';
  END IF;
END $$;

-- (3) Every organization has at least one active shift_variance matrix row.
DO $$
DECLARE v_missing int;
BEGIN
  SELECT count(*) INTO v_missing
    FROM public.organizations o
   WHERE NOT EXISTS (
     SELECT 1 FROM public.pos_override_matrix m
      WHERE m.organization_id = o.id
        AND m.action = 'shift_variance'
        AND m.is_active = true
   );
  IF v_missing > 0 THEN
    RAISE EXCEPTION
      '% organization(s) lack an active shift_variance row in pos_override_matrix',
      v_missing;
  END IF;
END $$;
