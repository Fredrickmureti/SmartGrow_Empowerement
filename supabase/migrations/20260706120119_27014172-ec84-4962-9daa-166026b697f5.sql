-- 1. Extend the bank export template table with the same metadata surface
--    used by certificate and return templates.
ALTER TABLE public.localization_pack_bank_export_templates
  ADD COLUMN IF NOT EXISTS spec_reference       text,
  ADD COLUMN IF NOT EXISTS effective_date       date,
  ADD COLUMN IF NOT EXISTS sunset_date          date,
  ADD COLUMN IF NOT EXISTS authority_id         uuid REFERENCES public.statutory_authorities(id),
  ADD COLUMN IF NOT EXISTS legal_reference      text,
  ADD COLUMN IF NOT EXISTS regulation_citation  text,
  ADD COLUMN IF NOT EXISTS pack_version_id      uuid;

-- 2. Backfill the shipped KE row so existing tenants pass the new gate.
UPDATE public.localization_pack_bank_export_templates
   SET spec_reference      = COALESCE(spec_reference, 'KBA Pesalink Bulk File Spec v1.2 (IPSL, 2019)'),
       effective_date      = COALESCE(effective_date, DATE '2019-01-01'),
       legal_reference     = COALESCE(legal_reference, 'National Payment System Act, No. 39 of 2011'),
       regulation_citation = COALESCE(regulation_citation,
                                      'CBK National Payment System Regulations, 2014 — Bulk Payment Instructions')
 WHERE pack_id = (SELECT id FROM public.localization_packs WHERE country_code = 'KE');

-- 3. Structural trigger: bank export templates cannot be authored without
--    a spec reference + effective date (>= 2000-01-01). authority_id and
--    legal metadata remain optional because bank-clearing formats (e.g.
--    Pesalink) are issued by clearing houses, not statutory authorities.
CREATE OR REPLACE FUNCTION public.enforce_bank_export_template_meta()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.spec_reference IS NULL OR btrim(NEW.spec_reference) = '' THEN
    RAISE EXCEPTION
      'bank export template "%": spec_reference is required (bank-file spec version, e.g. "KBA Pesalink Bulk File Spec v1.2").',
      NEW.format_code
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.effective_date IS NULL OR NEW.effective_date < DATE '2000-01-01' THEN
    RAISE EXCEPTION
      'bank export template "%": effective_date must be set and >= 2000-01-01 (got %).',
      NEW.format_code, NEW.effective_date
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.legal_reference IS NOT NULL
     AND (NEW.regulation_citation IS NULL OR btrim(NEW.regulation_citation) = '') THEN
    RAISE EXCEPTION
      'bank export template "%": regulation_citation is required whenever legal_reference is set.',
      NEW.format_code
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.spec IS NULL OR jsonb_typeof(NEW.spec) <> 'object' THEN
    RAISE EXCEPTION
      'bank export template "%": spec must be a JSON object describing the file format (columns, delimiter, line_ending, …).',
      NEW.format_code
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_bank_export_template_meta
  ON public.localization_pack_bank_export_templates;
CREATE TRIGGER trg_bank_export_template_meta
BEFORE INSERT OR UPDATE ON public.localization_pack_bank_export_templates
FOR EACH ROW EXECUTE FUNCTION public.enforce_bank_export_template_meta();

COMMENT ON FUNCTION public.enforce_bank_export_template_meta() IS
  'ADR 0060 — every bank export template must carry a bank-spec reference and an effective date. Legal/regulatory citation optional (bank-clearing formats are not statutory instruments).';