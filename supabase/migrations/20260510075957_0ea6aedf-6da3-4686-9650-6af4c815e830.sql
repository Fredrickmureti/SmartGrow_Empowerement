-- R4 — Liability primacy + pack-driven scheduling

ALTER TABLE public.payroll_liabilities
  ADD COLUMN IF NOT EXISTS payroll_run_id uuid REFERENCES public.payroll_runs(id);

CREATE INDEX IF NOT EXISTS idx_payroll_liabilities_run
  ON public.payroll_liabilities(payroll_run_id);

-- Backfill payroll_run_id from sources where there is exactly one source row.
UPDATE public.payroll_liabilities l
   SET payroll_run_id = s.run_id
  FROM (
    SELECT liability_id, (array_agg(payroll_run_id))[1] AS run_id, COUNT(*) AS n
      FROM public.payroll_liability_sources
     GROUP BY liability_id
     HAVING COUNT(*) = 1
  ) s
 WHERE s.liability_id = l.id AND l.payroll_run_id IS NULL;

UPDATE public.payroll_liabilities l
   SET country_code = lp.country_code
  FROM public.installed_localization_packs ilp
  JOIN public.localization_packs lp ON lp.id = ilp.pack_id
 WHERE ilp.organization_id = l.organization_id
   AND (ilp.business_id IS NOT DISTINCT FROM l.business_id OR ilp.business_id IS NULL)
   AND ilp.status = 'active'
   AND l.country_code IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_payroll_liabilities_run_rule
  ON public.payroll_liabilities(payroll_run_id, rule_code)
  WHERE payroll_run_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.compute_remittance_due_date(
  p_organization_id uuid,
  p_business_id uuid,
  p_country_code text,
  p_rule_code text,
  p_period_end date
) RETURNS date
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_due_day smallint;
  v_due_month smallint;
  v_frequency text;
  v_year int;
  v_month int;
BEGIN
  IF p_period_end IS NULL THEN RETURN NULL; END IF;

  SELECT s.due_day, s.due_month, s.frequency
    INTO v_due_day, v_due_month, v_frequency
    FROM public.localization_pack_remittance_schedules s
    JOIN public.installed_localization_packs ilp ON ilp.pack_id = s.pack_id
    JOIN public.localization_packs lp ON lp.id = s.pack_id
   WHERE ilp.organization_id = p_organization_id
     AND (ilp.business_id IS NOT DISTINCT FROM p_business_id OR ilp.business_id IS NULL)
     AND ilp.status = 'active'
     AND lp.country_code = p_country_code
     AND s.rule_code = p_rule_code
   ORDER BY (ilp.business_id IS NOT NULL) DESC
   LIMIT 1;

  IF v_due_day IS NULL THEN
    RETURN (date_trunc('month', p_period_end) + interval '1 month' + interval '8 days')::date;
  END IF;

  v_frequency := COALESCE(v_frequency, 'monthly');

  IF v_frequency = 'monthly' THEN
    RETURN (date_trunc('month', p_period_end) + interval '1 month' + make_interval(days => v_due_day - 1))::date;
  ELSIF v_frequency = 'quarterly' THEN
    RETURN (date_trunc('quarter', p_period_end) + interval '3 months' + make_interval(days => v_due_day - 1))::date;
  ELSIF v_frequency = 'annual' THEN
    v_year := EXTRACT(YEAR FROM p_period_end)::int + 1;
    v_month := COALESCE(v_due_month, 1);
    RETURN make_date(v_year, v_month, v_due_day);
  ELSE
    RETURN (date_trunc('month', p_period_end) + interval '1 month' + make_interval(days => v_due_day - 1))::date;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.resolve_liability_account_for_rule(
  p_organization_id uuid,
  p_business_id uuid,
  p_country_code text,
  p_rule_code text
) RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_setting_key text;
  v_account_id uuid;
BEGIN
  SELECT s.liability_account_setting_key
    INTO v_setting_key
    FROM public.localization_pack_remittance_schedules s
    JOIN public.installed_localization_packs ilp ON ilp.pack_id = s.pack_id
    JOIN public.localization_packs lp ON lp.id = s.pack_id
   WHERE ilp.organization_id = p_organization_id
     AND (ilp.business_id IS NOT DISTINCT FROM p_business_id OR ilp.business_id IS NULL)
     AND ilp.status = 'active'
     AND lp.country_code = p_country_code
     AND s.rule_code = p_rule_code
   LIMIT 1;

  IF v_setting_key IS NOT NULL THEN
    SELECT account_id INTO v_account_id
      FROM public.default_account_settings
     WHERE organization_id = p_organization_id
       AND (business_id IS NOT DISTINCT FROM p_business_id OR business_id IS NULL)
       AND setting_key = v_setting_key
     ORDER BY (business_id IS NOT NULL) DESC
     LIMIT 1;
    IF v_account_id IS NOT NULL THEN RETURN v_account_id; END IF;
  END IF;

  SELECT account_id INTO v_account_id
    FROM public.default_account_settings
   WHERE organization_id = p_organization_id
     AND (business_id IS NOT DISTINCT FROM p_business_id OR business_id IS NULL)
     AND setting_key = p_rule_code || '_payable'
   ORDER BY (business_id IS NOT NULL) DESC
   LIMIT 1;
  RETURN v_account_id;
END $$;

CREATE OR REPLACE FUNCTION public.payroll_liabilities_fill_country()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.country_code IS NULL THEN
    SELECT lp.country_code INTO NEW.country_code
      FROM public.installed_localization_packs ilp
      JOIN public.localization_packs lp ON lp.id = ilp.pack_id
     WHERE ilp.organization_id = NEW.organization_id
       AND (ilp.business_id IS NOT DISTINCT FROM NEW.business_id OR ilp.business_id IS NULL)
       AND ilp.status = 'active'
     ORDER BY (ilp.business_id IS NOT NULL) DESC
     LIMIT 1;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_payroll_liabilities_fill_country ON public.payroll_liabilities;
CREATE TRIGGER trg_payroll_liabilities_fill_country
  BEFORE INSERT ON public.payroll_liabilities
  FOR EACH ROW EXECUTE FUNCTION public.payroll_liabilities_fill_country();

CREATE OR REPLACE VIEW public.v_payroll_remittances_compat AS
SELECT
  l.id,
  l.organization_id,
  l.business_id,
  l.payroll_run_id,
  l.rule_code AS remittance_type,
  l.label    AS remittance_label,
  l.original_amount AS amount,
  0::numeric AS employer_amount,
  l.status,
  l.due_date,
  NULL::date AS payment_date,
  NULL::text AS reference_number,
  NULL::text AS payment_method,
  l.notes,
  NULL::uuid AS paid_by,
  NULL::timestamptz AS paid_at,
  l.created_at,
  l.updated_at
FROM public.payroll_liabilities l;

COMMENT ON VIEW public.v_payroll_remittances_compat IS
  'R4 compatibility shim. payroll_remittances table is deprecated; use payroll_liabilities.';

COMMENT ON TABLE public.payroll_remittances IS
  'DEPRECATED (R4). New writes go to payroll_liabilities. Reads should migrate to v_payroll_remittances_compat or payroll_liabilities. Existing rows preserved for historical reference.';