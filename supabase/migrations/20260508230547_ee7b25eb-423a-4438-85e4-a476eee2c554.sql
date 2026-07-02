
-- 1. dynamic_field_schema column + seed defaults
ALTER TABLE public.loan_types
  ADD COLUMN IF NOT EXISTS dynamic_field_schema jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Unique (org, code) so we can ON CONFLICT seed safely
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'loan_types_org_code_key'
  ) THEN
    ALTER TABLE public.loan_types
      ADD CONSTRAINT loan_types_org_code_key UNIQUE (organization_id, code);
  END IF;
END$$;

-- Backfill default schemas based on kind
UPDATE public.loan_types SET dynamic_field_schema = jsonb_build_object(
  'fields', jsonb_build_array(
    jsonb_build_object('key','principal_amount','label','Principal Amount','type','number','required',true),
    jsonb_build_object('key','interest_rate','label','Interest Rate (%)','type','number','required',false),
    jsonb_build_object('key','total_installments','label','Installments','type','number','required',true),
    jsonb_build_object('key','start_date','label','Start Date','type','date','required',true),
    jsonb_build_object('key','description','label','Reason / Notes','type','text','required',false)
  )
) WHERE kind = 'loan' AND dynamic_field_schema = '{}'::jsonb;

UPDATE public.loan_types SET dynamic_field_schema = jsonb_build_object(
  'fields', jsonb_build_array(
    jsonb_build_object('key','principal_amount','label','Advance Amount','type','number','required',true),
    jsonb_build_object('key','start_date','label','Recover From Period','type','date','required',true),
    jsonb_build_object('key','description','label','Reason','type','text','required',true)
  )
) WHERE kind = 'salary_advance' AND dynamic_field_schema = '{}'::jsonb;

UPDATE public.loan_types SET dynamic_field_schema = jsonb_build_object(
  'fields', jsonb_build_array(
    jsonb_build_object('key','principal_amount','label','Amount','type','number','required',true),
    jsonb_build_object('key','total_installments','label','Installments','type','number','required',true),
    jsonb_build_object('key','start_date','label','Start Date','type','date','required',true),
    jsonb_build_object('key','description','label','Emergency Reason','type','text','required',true)
  )
) WHERE kind = 'emergency' AND dynamic_field_schema = '{}'::jsonb;

UPDATE public.loan_types SET dynamic_field_schema = jsonb_build_object(
  'fields', jsonb_build_array(
    jsonb_build_object('key','principal_amount','label','Asset Cost','type','number','required',true),
    jsonb_build_object('key','interest_rate','label','Interest Rate (%)','type','number','required',false),
    jsonb_build_object('key','total_installments','label','Installments','type','number','required',true),
    jsonb_build_object('key','start_date','label','Start Date','type','date','required',true),
    jsonb_build_object('key','description','label','Asset Reference','type','text','required',true)
  )
) WHERE kind = 'asset' AND dynamic_field_schema = '{}'::jsonb;

-- 2. Seed defaults for any organization missing them (idempotent)
DO $$
DECLARE _org RECORD;
BEGIN
  FOR _org IN SELECT id FROM public.organizations LOOP
    PERFORM public.seed_default_loan_types(_org.id);
  END LOOP;
END$$;

-- 3. Backfill loan_type_id on existing employee_loans
UPDATE public.employee_loans el
SET loan_type_id = lt.id
FROM public.loan_types lt
WHERE el.loan_type_id IS NULL
  AND lt.organization_id = el.organization_id
  AND ((el.loan_type = 'advance' AND lt.kind = 'salary_advance')
       OR (el.loan_type = 'loan' AND lt.kind = 'loan'));

-- 4. Replace generate_loan_schedule with dry-run support
CREATE OR REPLACE FUNCTION public.generate_loan_schedule(
  _loan_id uuid,
  _dry_run boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  l RECORD;
  i INTEGER;
  amt NUMERIC;
  remaining NUMERIC;
  period_start DATE;
  period_end DATE;
  n INTEGER;
  rows jsonb := '[]'::jsonb;
BEGIN
  SELECT * INTO l FROM public.employee_loans WHERE id = _loan_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('count', 0, 'rows', rows);
  END IF;

  IF NOT _dry_run THEN
    DELETE FROM public.loan_repayment_schedule
     WHERE loan_id = _loan_id AND status IN ('pending','skipped','cancelled');
  END IF;

  -- One-off advance: single row equal to outstanding balance
  IF l.repayment_method = 'one_off_next_payroll' THEN
    rows := jsonb_build_array(jsonb_build_object(
      'sequence',1,
      'due_period_start', l.start_date,
      'due_period_end', (l.start_date + INTERVAL '1 month' - INTERVAL '1 day')::date,
      'scheduled_amount', l.outstanding_balance
    ));
    IF NOT _dry_run THEN
      INSERT INTO public.loan_repayment_schedule (loan_id, sequence, due_period_start, due_period_end, scheduled_amount)
      VALUES (_loan_id, 1, l.start_date, (l.start_date + INTERVAL '1 month' - INTERVAL '1 day')::date, l.outstanding_balance)
      ON CONFLICT (loan_id, sequence) DO NOTHING;
    END IF;
    RETURN jsonb_build_object('count', 1, 'rows', rows);
  END IF;

  -- Percent-of-net: no fixed schedule (driven at payroll time)
  IF l.repayment_method = 'percent_of_net' THEN
    RETURN jsonb_build_object('count', 0, 'rows', rows, 'note', 'percent-of-net is computed each payroll');
  END IF;

  -- Fixed installment / fixed amount
  n := COALESCE(l.total_installments, 12);
  IF n <= 0 THEN n := 12; END IF;
  amt := ROUND(l.total_amount / n, 2);
  remaining := l.total_amount;
  period_start := l.start_date;

  FOR i IN 1..n LOOP
    period_end := (period_start + INTERVAL '1 month' - INTERVAL '1 day')::date;
    IF i = n THEN amt := remaining; END IF;
    rows := rows || jsonb_build_object(
      'sequence', i,
      'due_period_start', period_start,
      'due_period_end', period_end,
      'scheduled_amount', amt
    );
    IF NOT _dry_run THEN
      INSERT INTO public.loan_repayment_schedule (loan_id, sequence, due_period_start, due_period_end, scheduled_amount)
      VALUES (_loan_id, i, period_start, period_end, amt)
      ON CONFLICT (loan_id, sequence) DO NOTHING;
    END IF;
    remaining := remaining - amt;
    period_start := (period_start + INTERVAL '1 month')::date;
  END LOOP;

  RETURN jsonb_build_object('count', n, 'rows', rows);
END;
$function$;

-- recompute_loan_schedule: keep working with new signature
CREATE OR REPLACE FUNCTION public.recompute_loan_schedule(_loan_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE r jsonb;
BEGIN
  r := public.generate_loan_schedule(_loan_id, false);
  RETURN COALESCE((r->>'count')::int, 0);
END;
$$;

-- 5. Trigger: auto-seed default loan types when a new organization is created
CREATE OR REPLACE FUNCTION public.tg_seed_loan_types_on_org()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.seed_default_loan_types(NEW.id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS organizations_seed_loan_types ON public.organizations;
CREATE TRIGGER organizations_seed_loan_types
AFTER INSERT ON public.organizations
FOR EACH ROW EXECUTE FUNCTION public.tg_seed_loan_types_on_org();

-- 6. Timesheet payroll lock column (Stage 7 dependency, additive only)
ALTER TABLE public.timesheets
  ADD COLUMN IF NOT EXISTS payroll_locked_at timestamptz;

ALTER TABLE public.timesheet_submissions
  ADD COLUMN IF NOT EXISTS payroll_locked_at timestamptz;

-- payroll_work_entries source tracking
ALTER TABLE public.payroll_work_entries
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'attendance',
  ADD COLUMN IF NOT EXISTS source_record_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='payroll_work_entries_source_check') THEN
    ALTER TABLE public.payroll_work_entries
      ADD CONSTRAINT payroll_work_entries_source_check
      CHECK (source IN ('attendance','timesheet','manual','contract','holiday'));
  END IF;
END$$;
