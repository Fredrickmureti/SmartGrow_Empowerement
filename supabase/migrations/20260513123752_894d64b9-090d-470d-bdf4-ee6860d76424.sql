-- Phase 1 — allow '40mm' thermal paper everywhere a CHECK constraint
-- previously hardcoded only 58mm/80mm. Safe to re-run.

DO $$
DECLARE conname text;
BEGIN
  -- printer_profiles.paper_format
  FOR conname IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'printer_profiles'
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) ILIKE '%paper_format%'
  LOOP
    EXECUTE format('ALTER TABLE public.printer_profiles DROP CONSTRAINT %I', conname);
  END LOOP;
  ALTER TABLE public.printer_profiles
    ADD CONSTRAINT printer_profiles_paper_format_check
    CHECK (paper_format IN ('a4','letter','a5','80mm','58mm','40mm'));

  -- document_print_policies.paper_format
  FOR conname IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'document_print_policies'
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) ILIKE '%paper_format%'
  LOOP
    EXECUTE format('ALTER TABLE public.document_print_policies DROP CONSTRAINT %I', conname);
  END LOOP;
  ALTER TABLE public.document_print_policies
    ADD CONSTRAINT document_print_policies_paper_format_check
    CHECK (paper_format IN ('a4','letter','a5','80mm','58mm','40mm'));
END $$;