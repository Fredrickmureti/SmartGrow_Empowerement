-- W5 (ADR-0008): tighten document_print_policies.render_mode to runtime reality.
-- The 'html' enum value was scaffolded but never had a runtime path (Stage G
-- removed it from generate-document). Drop it so the schema reflects reality.

-- 1) Backfill any stray 'html' rows to 'pdf' (the safe default).
UPDATE public.document_print_policies
   SET render_mode = 'pdf'
 WHERE render_mode = 'html';

-- 2) Replace the CHECK constraint. The original was unnamed-by-convention so
--    we drop by the standard pattern Postgres assigns and recreate explicitly.
DO $$
DECLARE
  conname text;
BEGIN
  SELECT c.conname INTO conname
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
   WHERE t.relname = 'document_print_policies'
     AND c.contype = 'c'
     AND pg_get_constraintdef(c.oid) ILIKE '%render_mode%';
  IF conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.document_print_policies DROP CONSTRAINT %I', conname);
  END IF;
END$$;

ALTER TABLE public.document_print_policies
  ADD CONSTRAINT document_print_policies_render_mode_check
  CHECK (render_mode IN ('pdf','escpos'));

-- 3) Document printer_profile_id (reserved for W7).
COMMENT ON COLUMN public.document_print_policies.printer_profile_id
  IS 'Reserved for W7 (printer profiles); no FK yet';