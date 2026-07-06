
-- ================================================================
-- Kenya Pack v2026.4.0 — Return template metadata refresh + gate
-- ADR 0060 follow-through — Section 6 (return templates).
--
-- NO tenant business data is modified.
-- Publish fanout is a separate follow-up call (once the linter
-- passes clean on these rows).
-- ================================================================

-- 1. Backfill legal metadata on the 8 KE return templates so they
--    satisfy the pre-publish gate.  effective_date maps to the
--    gazette date each regime became the current filing shape.
DO $$
DECLARE
  _ke_pack UUID;
BEGIN
  SELECT id INTO _ke_pack FROM public.localization_packs
    WHERE country_code = 'KE' LIMIT 1;
  IF _ke_pack IS NULL THEN
    RAISE NOTICE 'KE pack not present; skipping return template refresh';
    RETURN;
  END IF;

  UPDATE public.localization_pack_return_templates SET
    effective_date      = DATE '2024-07-01',
    legal_reference     = 'Income Tax Act, CAP 470',
    regulation_citation = 'Section 37 — Monthly PAYE remittance return (iTax P10 CSV upload).'
  WHERE pack_id = _ke_pack AND code = 'P10';

  UPDATE public.localization_pack_return_templates SET
    effective_date      = DATE '2024-07-01',
    legal_reference     = 'Income Tax Act, CAP 470',
    regulation_citation = 'Section 35 — Annual PAYE reconciliation return (iTax P10A).'
  WHERE pack_id = _ke_pack AND code = 'P10A';

  UPDATE public.localization_pack_return_templates SET
    effective_date      = DATE '2024-07-01',
    legal_reference     = 'Income Tax Act, CAP 470',
    regulation_citation = 'Section 37 — Per-employee PAYE detail schedule (P10D).'
  WHERE pack_id = _ke_pack AND code = 'P10D';

  UPDATE public.localization_pack_return_templates SET
    effective_date      = DATE '2026-02-01',
    legal_reference     = 'NSSF Act No. 45 of 2013',
    regulation_citation = 'Section 20 — Monthly contribution return for Tier I and Tier II earnings.'
  WHERE pack_id = _ke_pack AND code = 'NSSF_RET';

  UPDATE public.localization_pack_return_templates SET
    effective_date      = DATE '2024-10-01',
    legal_reference     = 'Social Health Insurance Act No. 16 of 2023',
    regulation_citation = 'Section 27 — Monthly SHIF contribution return.'
  WHERE pack_id = _ke_pack AND code = 'SHIF_RET';

  UPDATE public.localization_pack_return_templates SET
    effective_date      = DATE '2024-07-01',
    legal_reference     = 'Affordable Housing Act No. 4 of 2024',
    regulation_citation = 'Section 4 — Monthly Affordable Housing Levy return.'
  WHERE pack_id = _ke_pack AND code = 'AHL_RET';

  UPDATE public.localization_pack_return_templates SET
    effective_date      = DATE '2024-07-01',
    legal_reference     = 'Industrial Training Act, CAP 237',
    regulation_citation = 'Section 5B — Annual employer NITA contribution return.'
  WHERE pack_id = _ke_pack AND code = 'NITA_RET';

  UPDATE public.localization_pack_return_templates SET
    effective_date      = DATE '2024-01-01',
    legal_reference     = 'Higher Education Loans Board Act, CAP 213A',
    regulation_citation = 'Section 15 — Monthly HELB loan repayment schedule.'
  WHERE pack_id = _ke_pack AND code = 'HELB_LR';
END $$;

-- 2. Structural gate on return templates.  Unlike certificates,
--    return templates are aggregation specs (columns + filters +
--    totals) that feed the iTax / portal-upload builders; they do
--    NOT use the section-based PDF layout.  Enforce the aggregation
--    contract + legal metadata at write time so the same violation
--    the publish linter rejects is also rejected here.
CREATE OR REPLACE FUNCTION public.enforce_return_template_structure()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  _cols          JSONB;
  _totals        JSONB;
  _filters       JSONB;
  _statutory_re  TEXT := '^(P9|P10|VAT|PAYE|NSSF|SHIF|AHL|WHT|NHIF|NITA|HELB)';
  _bad_col       INTEGER;
BEGIN
  _cols   := COALESCE(NEW.body -> 'columns', '[]'::jsonb);
  _totals := COALESCE(NEW.body -> 'totals',  '[]'::jsonb);
  _filters := NEW.body -> 'filters';

  IF jsonb_typeof(_cols) <> 'array' OR jsonb_array_length(_cols) = 0 THEN
    RAISE EXCEPTION 'Return template % (%): body.columns must be a non-empty array — return templates are aggregation specs.',
                    NEW.code, NEW.display_name
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT COUNT(*) INTO _bad_col
    FROM jsonb_array_elements(_cols) AS elem
   WHERE (elem->>'key') IS NULL OR (elem->>'source') IS NULL;
  IF _bad_col > 0 THEN
    RAISE EXCEPTION 'Return template % (%): every column must have "key" and "source" (% offending column(s)).',
                    NEW.code, NEW.display_name, _bad_col
      USING ERRCODE = 'check_violation';
  END IF;

  IF _filters IS NULL OR jsonb_typeof(_filters) <> 'object' THEN
    RAISE EXCEPTION 'Return template % (%): body.filters must specify rule_codes / payslip_status to scope the aggregation.',
                    NEW.code, NEW.display_name
      USING ERRCODE = 'check_violation';
  END IF;

  IF jsonb_typeof(_totals) <> 'array' OR jsonb_array_length(_totals) = 0 THEN
    RAISE EXCEPTION 'Return template % (%): body.totals must list the columns to sum in the footer / reconciliation.',
                    NEW.code, NEW.display_name
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.effective_date IS NULL OR NEW.effective_date < DATE '2000-01-01' THEN
    RAISE EXCEPTION 'Return template % (%): effective_date must be set and >= 2000-01-01 (got %).',
                    NEW.code, NEW.display_name, NEW.effective_date
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.code ~ _statutory_re AND NEW.authority_id IS NULL THEN
    RAISE EXCEPTION 'Return template % (%): statutory code requires authority_id (link a statutory_authorities row).',
                    NEW.code, NEW.display_name
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.legal_reference IS NOT NULL AND NEW.legal_reference <> ''
     AND (NEW.regulation_citation IS NULL OR NEW.regulation_citation = '') THEN
    RAISE EXCEPTION 'Return template % (%): regulation_citation is required whenever legal_reference is set.',
                    NEW.code, NEW.display_name
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_return_template_structure
  ON public.localization_pack_return_templates;

CREATE TRIGGER trg_return_template_structure
  BEFORE INSERT OR UPDATE ON public.localization_pack_return_templates
  FOR EACH ROW EXECUTE FUNCTION public.enforce_return_template_structure();
