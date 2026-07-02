
DO $$ BEGIN
  CREATE TYPE public.garnishment_status AS ENUM ('active','suspended','satisfied','released','expired');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE public.employee_garnishments
  ADD COLUMN IF NOT EXISTS status public.garnishment_status NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS status_changed_at timestamptz,
  ADD COLUMN IF NOT EXISTS status_changed_by uuid,
  ADD COLUMN IF NOT EXISTS status_reason text,
  ADD COLUMN IF NOT EXISTS payee_name text,
  ADD COLUMN IF NOT EXISTS payee_account text,
  ADD COLUMN IF NOT EXISTS payee_bank text,
  ADD COLUMN IF NOT EXISTS payee_reference text,
  ADD COLUMN IF NOT EXISTS document_url text,
  ADD COLUMN IF NOT EXISTS document_filename text,
  ADD COLUMN IF NOT EXISTS minimum_take_home_amount numeric(18,2),
  ADD COLUMN IF NOT EXISTS aggregate_cap_exempt boolean NOT NULL DEFAULT false;

UPDATE public.employee_garnishments
SET status = CASE WHEN is_active THEN 'active'::public.garnishment_status ELSE 'suspended'::public.garnishment_status END
WHERE status_changed_at IS NULL;

CREATE TABLE IF NOT EXISTS public.garnishment_kind_defaults (
  kind text PRIMARY KEY,
  default_priority integer NOT NULL,
  always_first boolean NOT NULL DEFAULT false,
  counts_toward_aggregate_cap boolean NOT NULL DEFAULT true,
  description text
);
GRANT SELECT ON public.garnishment_kind_defaults TO anon, authenticated;
GRANT ALL ON public.garnishment_kind_defaults TO service_role;
ALTER TABLE public.garnishment_kind_defaults ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "garnishment_kind_defaults_read" ON public.garnishment_kind_defaults;
CREATE POLICY "garnishment_kind_defaults_read" ON public.garnishment_kind_defaults FOR SELECT USING (true);

INSERT INTO public.garnishment_kind_defaults (kind, default_priority, always_first, counts_toward_aggregate_cap, description) VALUES
  ('child_support',   10,  true,  false, 'Child/family support: highest priority, exempt from aggregate cap in most jurisdictions'),
  ('tax_levy',        20,  false, true,  'Government tax levy: ranks after support orders'),
  ('court_order',     30,  false, true,  'General court-ordered judgment'),
  ('student_loan',    40,  false, true,  'Government-administered student loan'),
  ('wage_assignment', 50,  false, true,  'Voluntary wage assignment'),
  ('creditor',        60,  false, true,  'Commercial creditor garnishment'),
  ('other',          100,  false, true,  'Other deduction order')
ON CONFLICT (kind) DO NOTHING;

ALTER TABLE public.payroll_settings
  ADD COLUMN IF NOT EXISTS garnishment_aggregate_cap_pct numeric(5,4),
  ADD COLUMN IF NOT EXISTS garnishment_minimum_take_home_amount numeric(18,2),
  ADD COLUMN IF NOT EXISTS garnishment_minimum_take_home_pct numeric(5,4);

COMMENT ON COLUMN public.payroll_settings.garnishment_aggregate_cap_pct IS
  'Max fraction of disposable earnings garnishable per period. CCPA US: 0.25; KE one-third: 0.3333. Null = no cap.';
COMMENT ON COLUMN public.payroll_settings.garnishment_minimum_take_home_amount IS
  'Absolute minimum take-home after garnishments per period.';
COMMENT ON COLUMN public.payroll_settings.garnishment_minimum_take_home_pct IS
  'Minimum fraction of gross retained after garnishments.';

CREATE TABLE IF NOT EXISTS public.garnishment_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  garnishment_id uuid NOT NULL,
  action text NOT NULL,
  changed_by uuid,
  changed_at timestamptz NOT NULL DEFAULT now(),
  before_state jsonb,
  after_state jsonb,
  reason text
);
CREATE INDEX IF NOT EXISTS garnishment_audit_log_garnishment_idx ON public.garnishment_audit_log(garnishment_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS garnishment_audit_log_org_idx ON public.garnishment_audit_log(organization_id, changed_at DESC);

GRANT SELECT ON public.garnishment_audit_log TO authenticated;
GRANT ALL ON public.garnishment_audit_log TO service_role;
ALTER TABLE public.garnishment_audit_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "garnishment_audit_read_hr" ON public.garnishment_audit_log;
CREATE POLICY "garnishment_audit_read_hr" ON public.garnishment_audit_log
  FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin')
    OR public.has_role(auth.uid(), 'owner')
    OR public.has_role(auth.uid(), 'accountant')
    OR public.has_role(auth.uid(), 'super_admin')
  );

CREATE OR REPLACE FUNCTION public.garnishment_audit_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_action text;
  v_actor uuid := auth.uid();
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_action := 'created';
    INSERT INTO public.garnishment_audit_log(organization_id, garnishment_id, action, changed_by, after_state)
    VALUES (NEW.organization_id, NEW.id, v_action, v_actor, to_jsonb(NEW));
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.total_owed IS NOT NULL
       AND NEW.total_paid >= NEW.total_owed
       AND OLD.status = 'active'
       AND NEW.status = 'active' THEN
      NEW.status := 'satisfied';
      NEW.status_changed_at := now();
      NEW.is_active := false;
    END IF;
    IF NEW.end_date IS NOT NULL
       AND NEW.end_date < CURRENT_DATE
       AND NEW.status = 'active' THEN
      NEW.status := 'expired';
      NEW.status_changed_at := now();
      NEW.is_active := false;
    END IF;
    IF OLD.status IS DISTINCT FROM NEW.status THEN
      v_action := 'status_changed';
      NEW.status_changed_at := COALESCE(NEW.status_changed_at, now());
      NEW.status_changed_by := COALESCE(NEW.status_changed_by, v_actor);
      NEW.is_active := (NEW.status = 'active');
    ELSIF OLD.total_paid IS DISTINCT FROM NEW.total_paid THEN
      v_action := 'paid';
    ELSE
      v_action := 'updated';
    END IF;
    INSERT INTO public.garnishment_audit_log(organization_id, garnishment_id, action, changed_by, before_state, after_state)
    VALUES (NEW.organization_id, NEW.id, v_action, v_actor, to_jsonb(OLD), to_jsonb(NEW));
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO public.garnishment_audit_log(organization_id, garnishment_id, action, changed_by, before_state)
    VALUES (OLD.organization_id, OLD.id, 'deleted', v_actor, to_jsonb(OLD));
    RETURN OLD;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS garnishment_audit ON public.employee_garnishments;
CREATE TRIGGER garnishment_audit
BEFORE INSERT OR UPDATE OR DELETE ON public.employee_garnishments
FOR EACH ROW EXECUTE FUNCTION public.garnishment_audit_trigger();

-- Ledger: derived live from payslip_lines (single source of truth).
-- rule_code for garnishment lines is exactly 'garnishment_<uuid>'.
CREATE OR REPLACE VIEW public.garnishment_ledger
WITH (security_invoker = on) AS
SELECT
  substring(pl.rule_code from 13)::uuid AS garnishment_id,
  pl.payslip_id,
  pl.organization_id,
  pl.employee_id,
  pl.payroll_run_id,
  pr.pay_period_start,
  pr.pay_period_end,
  pr.payment_date,
  pr.status AS run_status,
  pl.employee_amount AS amount,
  pl.created_at
FROM public.payslip_lines pl
JOIN public.payroll_runs pr ON pr.id = pl.payroll_run_id
WHERE pl.rule_code LIKE 'garnishment\_%' ESCAPE '\'
  AND length(pl.rule_code) = 12 + 36;

GRANT SELECT ON public.garnishment_ledger TO authenticated;
