-- Regression guard (2026-08-16): "Wipe all transactional data" aborted with
--   reset_module__warehouse could not clear: wms_license_plates (23503)
--
-- Root cause: stock_quants.lpn_id references wms_license_plates ON DELETE
-- RESTRICT. reset_module__warehouse runs BEFORE reset_module__inventory (which
-- owns stock_quants), and its internal retry loop can only reorder WMS tables —
-- so a single quant parked on a handling unit made the plate undeletable and
-- failed the whole reset.
--
-- Fix: reset_module__warehouse clears stock_quants for the org before the WMS
-- sweep. This test locks in both the FK shape that causes the hazard and the
-- pre-clear step.

DO $$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'reset_module__warehouse';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'reset_module__warehouse is missing';
  END IF;

  IF v_def !~ 'DELETE FROM public\.stock_quants' THEN
    RAISE EXCEPTION 'reset_module__warehouse must clear stock_quants before deleting wms_license_plates';
  END IF;

  -- The stock_quants delete must appear BEFORE the WMS table loop executes.
  IF position('DELETE FROM public.stock_quants' in v_def)
     > position('FOR v_pass IN' in v_def) THEN
    RAISE EXCEPTION 'stock_quants pre-clear must run before the WMS retry loop';
  END IF;

  -- Document the hazard: if this FK is ever relaxed the guard above can be
  -- revisited, but while it is RESTRICT the pre-clear is mandatory.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'stock_quants_lpn_id_fkey'
       AND confdeltype = 'r'
  ) THEN
    RAISE NOTICE 'stock_quants_lpn_id_fkey is no longer RESTRICT — revisit this guard';
  END IF;
END $$;
