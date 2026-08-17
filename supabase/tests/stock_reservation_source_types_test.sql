-- INV-SIM guard (2026-08-17): every p_source_type literal that live code passes
-- to reserve_stock_atomic MUST be accepted by stock_reservations_source_type_check.
-- Regression: 'replenishment' (_wms_replen_reserve) and 'pick_wave'
-- (release_pick_wave) were missing, so replenishment auto-dispatch failed 23514.
DO $$
DECLARE
  v_def text;
  v_lit text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def
    FROM pg_constraint
   WHERE conrelid = 'public.stock_reservations'::regclass
     AND conname = 'stock_reservations_source_type_check';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'INV-SIM: stock_reservations_source_type_check is missing';
  END IF;

  FOR v_lit IN
    SELECT DISTINCT (regexp_matches(
             pg_get_functiondef(p.oid),
             'p_source_type\s*(?:=>|:=)\s*''([a-z_]+)''', 'g'))[1]
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
  LOOP
    IF v_def NOT LIKE '%''' || v_lit || '''%' THEN
      RAISE EXCEPTION 'INV-SIM: reservation source_type % is written by code but rejected by the CHECK constraint', v_lit;
    END IF;
  END LOOP;
END $$;
