
-- ===========================================================================
-- WAVE 1.4 + WAVE 2 (2.1, 2.2, 2.3)
-- ===========================================================================

-- 2.1 payroll_runs.locked_at / locked_by ------------------------------------
ALTER TABLE public.payroll_runs
  ADD COLUMN IF NOT EXISTS locked_at  timestamptz,
  ADD COLUMN IF NOT EXISTS locked_by  uuid REFERENCES auth.users(id);

CREATE INDEX IF NOT EXISTS idx_payroll_runs_locked
  ON public.payroll_runs (organization_id, locked_at)
  WHERE locked_at IS NOT NULL;

CREATE OR REPLACE FUNCTION public.trg_payroll_runs_stamp_lock()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.status IN ('approved','posted','paid','completed')
       AND COALESCE(OLD.status,'') NOT IN ('approved','posted','paid','completed')
       AND NEW.locked_at IS NULL THEN
      NEW.locked_at := now();
      NEW.locked_by := COALESCE(NEW.approved_by, auth.uid());
    END IF;
    IF NEW.status = 'draft' AND OLD.status <> 'draft' THEN
      NEW.locked_at := NULL;
      NEW.locked_by := NULL;
    END IF;
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_payroll_runs_stamp_lock ON public.payroll_runs;
CREATE TRIGGER trg_payroll_runs_stamp_lock
  BEFORE UPDATE ON public.payroll_runs
  FOR EACH ROW EXECUTE FUNCTION public.trg_payroll_runs_stamp_lock();

UPDATE public.payroll_runs
SET locked_at = COALESCE(approved_at, posted_at, payment_date::timestamptz, updated_at, created_at),
    locked_by = COALESCE(approved_by, posted_by)
WHERE status IN ('approved','posted','paid','completed')
  AND locked_at IS NULL;

-- 2.2 currency on payroll_runs + payslips -----------------------------------
ALTER TABLE public.payroll_runs ADD COLUMN IF NOT EXISTS currency text;
ALTER TABLE public.payslips     ADD COLUMN IF NOT EXISTS currency text;

UPDATE public.payroll_runs r
SET currency = COALESCE(r.currency, b.base_currency, 'USD')
FROM public.businesses b
WHERE r.business_id = b.id AND r.currency IS NULL;
UPDATE public.payroll_runs SET currency = 'USD' WHERE currency IS NULL;

UPDATE public.payslips p
SET currency = COALESCE(p.currency, r.currency, 'USD')
FROM public.payroll_runs r
WHERE p.payroll_run_id = r.id AND p.currency IS NULL;
UPDATE public.payslips SET currency = 'USD' WHERE currency IS NULL;

ALTER TABLE public.payroll_runs ALTER COLUMN currency SET NOT NULL;
ALTER TABLE public.payslips     ALTER COLUMN currency SET NOT NULL;

CREATE OR REPLACE FUNCTION public.trg_payroll_runs_default_currency()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.currency IS NULL THEN
    SELECT base_currency INTO NEW.currency FROM public.businesses WHERE id = NEW.business_id;
    IF NEW.currency IS NULL THEN NEW.currency := 'USD'; END IF;
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_payroll_runs_default_currency ON public.payroll_runs;
CREATE TRIGGER trg_payroll_runs_default_currency
  BEFORE INSERT ON public.payroll_runs
  FOR EACH ROW EXECUTE FUNCTION public.trg_payroll_runs_default_currency();

CREATE OR REPLACE FUNCTION public.trg_payslip_currency_match()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_run_currency text;
BEGIN
  SELECT currency INTO v_run_currency FROM public.payroll_runs WHERE id = NEW.payroll_run_id;
  IF v_run_currency IS NULL THEN
    RAISE EXCEPTION 'payroll_run % has no currency', NEW.payroll_run_id;
  END IF;
  IF NEW.currency IS NULL THEN
    NEW.currency := v_run_currency;
  ELSIF NEW.currency <> v_run_currency THEN
    RAISE EXCEPTION 'payslip currency (%) must match payroll_run currency (%)',
      NEW.currency, v_run_currency USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_payslip_currency_match ON public.payslips;
CREATE TRIGGER trg_payslip_currency_match
  BEFORE INSERT OR UPDATE OF currency, payroll_run_id ON public.payslips
  FOR EACH ROW EXECUTE FUNCTION public.trg_payslip_currency_match();

-- 2.3 employees.manager_id cycle guard --------------------------------------
CREATE OR REPLACE FUNCTION public.trg_employees_manager_cycle_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_current uuid; v_depth int := 0;
BEGIN
  IF NEW.manager_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.manager_id = NEW.id THEN
    RAISE EXCEPTION 'Employee % cannot be their own manager', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  v_current := NEW.manager_id;
  WHILE v_current IS NOT NULL AND v_depth < 50 LOOP
    IF v_current = NEW.id THEN
      RAISE EXCEPTION 'Manager assignment for employee % creates a cycle', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT manager_id INTO v_current FROM public.employees WHERE id = v_current;
    v_depth := v_depth + 1;
  END LOOP;
  IF v_depth >= 50 THEN
    RAISE EXCEPTION 'Manager chain for employee % exceeds depth limit (possible cycle)', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_employees_manager_cycle_guard ON public.employees;
CREATE TRIGGER trg_employees_manager_cycle_guard
  BEFORE INSERT OR UPDATE OF manager_id ON public.employees
  FOR EACH ROW EXECUTE FUNCTION public.trg_employees_manager_cycle_guard();

-- 1.4 Vault-migrate cron jobs 7 and 21 --------------------------------------
DO $$
DECLARE v_anon_key text := 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imprc3ptcnJveWpmZHdva2JremlzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc4MzkwMzEsImV4cCI6MjA4MzQxNTAzMX0.iJjPAh8zaed1XbgKnRZp63JLNU37Z72CJPHlSnEPaQc';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'cron_caller_jwt') THEN
    PERFORM vault.create_secret(v_anon_key, 'cron_caller_jwt',
      'Anon JWT used by pg_cron jobs to invoke /functions endpoints');
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.cron_caller_auth_header()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, vault AS $$
  SELECT jsonb_build_object(
    'Content-Type', 'application/json',
    'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_caller_jwt' LIMIT 1)
  );
$$;

REVOKE ALL ON FUNCTION public.cron_caller_auth_header() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cron_caller_auth_header() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cron_caller_auth_header() TO postgres, service_role;

SELECT cron.unschedule(7);
SELECT cron.schedule(
  'check-leave-expiry-daily',
  '0 7 * * *',
  $cmd$
  SELECT net.http_post(
    url     := 'https://jkszmrroyjfdwokbkzis.supabase.co/functions/v1/check-leave-expiry',
    headers := public.cron_caller_auth_header(),
    body    := '{}'::jsonb
  );
  $cmd$
);

SELECT cron.unschedule(21);
SELECT cron.schedule(
  'attendance-missed-checkout-15min',
  '*/15 * * * *',
  $cmd$
  SELECT net.http_post(
    url     := 'https://jkszmrroyjfdwokbkzis.supabase.co/functions/v1/attendance-missed-checkout',
    headers := public.cron_caller_auth_header(),
    body    := '{}'::jsonb
  );
  $cmd$
);
