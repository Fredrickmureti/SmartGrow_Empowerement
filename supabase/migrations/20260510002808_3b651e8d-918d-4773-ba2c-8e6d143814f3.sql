-- =======================================================================
-- R2: pay_schedule_id FK on payroll_runs + generic payroll audit trigger
-- =======================================================================

-- 1. payroll_runs.pay_schedule_id (nullable, opt-in) -------------------
ALTER TABLE public.payroll_runs
  ADD COLUMN IF NOT EXISTS pay_schedule_id uuid
    REFERENCES public.pay_schedules(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_payroll_runs_pay_schedule
  ON public.payroll_runs(pay_schedule_id)
  WHERE pay_schedule_id IS NOT NULL;

-- Validation trigger — only fires when pay_schedule_id is set.
CREATE OR REPLACE FUNCTION public.payroll_run_validate_schedule()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sched RECORD;
  v_min_payment_date DATE;
BEGIN
  IF NEW.pay_schedule_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT id, business_id, frequency, payment_offset_days, is_active
    INTO v_sched
    FROM public.pay_schedules
   WHERE id = NEW.pay_schedule_id;

  IF v_sched.id IS NULL THEN
    RAISE EXCEPTION 'pay_schedule % not found', NEW.pay_schedule_id;
  END IF;

  IF v_sched.business_id <> NEW.business_id THEN
    RAISE EXCEPTION 'pay_schedule % belongs to a different business', NEW.pay_schedule_id;
  END IF;

  IF NEW.pay_period_end < NEW.pay_period_start THEN
    RAISE EXCEPTION 'pay_period_end (%) must be on or after pay_period_start (%)',
      NEW.pay_period_end, NEW.pay_period_start;
  END IF;

  IF NEW.payment_date IS NOT NULL THEN
    v_min_payment_date := NEW.pay_period_end + COALESCE(v_sched.payment_offset_days, 0);
    IF NEW.payment_date < v_min_payment_date THEN
      RAISE EXCEPTION 'payment_date (%) must be on or after period_end + payment_offset_days (%)',
        NEW.payment_date, v_min_payment_date;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_payroll_run_validate_schedule ON public.payroll_runs;
CREATE TRIGGER trg_payroll_run_validate_schedule
  BEFORE INSERT OR UPDATE OF pay_schedule_id, pay_period_start, pay_period_end, payment_date, business_id
  ON public.payroll_runs
  FOR EACH ROW EXECUTE FUNCTION public.payroll_run_validate_schedule();

-- 2. Generic payroll audit logger -------------------------------------
-- Writes status/amount transitions to the existing audit_logs table.
CREATE OR REPLACE FUNCTION public.log_payroll_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_entity_type TEXT := TG_ARGV[0];
  v_entity_name TEXT;
  v_old JSONB := NULL;
  v_new JSONB := NULL;
  v_summary TEXT;
  v_org_id UUID;
BEGIN
  -- Resolve org id + entity name + minimal jsonb subsets per table.
  IF TG_TABLE_NAME = 'payroll_runs' THEN
    v_org_id := COALESCE(NEW.organization_id, OLD.organization_id);
    v_entity_name := COALESCE(NEW.payroll_number, OLD.payroll_number);
    IF TG_OP = 'UPDATE' THEN
      v_old := jsonb_build_object('status', OLD.status, 'posted_at', OLD.posted_at,
                                  'approved_at', OLD.approved_at, 'reversed_at', OLD.reversed_at);
      v_new := jsonb_build_object('status', NEW.status, 'posted_at', NEW.posted_at,
                                  'approved_at', NEW.approved_at, 'reversed_at', NEW.reversed_at);
      v_summary := COALESCE(OLD.status, '∅') || ' → ' || COALESCE(NEW.status, '∅');
    ELSE
      v_new := jsonb_build_object('status', NEW.status, 'pay_period_start', NEW.pay_period_start,
                                  'pay_period_end', NEW.pay_period_end);
      v_summary := 'created (' || COALESCE(NEW.status, 'draft') || ')';
    END IF;
  ELSIF TG_TABLE_NAME = 'payslips' THEN
    v_org_id := COALESCE(NEW.organization_id, OLD.organization_id);
    v_entity_name := COALESCE(NEW.payslip_number, OLD.payslip_number, NEW.id::text);
    v_old := jsonb_build_object('status', OLD.status, 'paid_at', OLD.paid_at);
    v_new := jsonb_build_object('status', NEW.status, 'paid_at', NEW.paid_at);
    v_summary := COALESCE(OLD.status, '∅') || ' → ' || COALESCE(NEW.status, '∅');
  ELSIF TG_TABLE_NAME = 'payroll_liabilities' THEN
    v_org_id := COALESCE(NEW.organization_id, OLD.organization_id);
    v_entity_name := COALESCE(NEW.rule_code, OLD.rule_code) || ' ' ||
                     to_char(COALESCE(NEW.period_start, OLD.period_start), 'YYYY-MM');
    v_old := jsonb_build_object('status', OLD.status, 'paid_amount', OLD.paid_amount,
                                'outstanding_amount', OLD.outstanding_amount);
    v_new := jsonb_build_object('status', NEW.status, 'paid_amount', NEW.paid_amount,
                                'outstanding_amount', NEW.outstanding_amount);
    v_summary := COALESCE(OLD.status, '∅') || ' → ' || COALESCE(NEW.status, '∅') ||
                 ' (paid ' || COALESCE(OLD.paid_amount, 0)::text || ' → ' || COALESCE(NEW.paid_amount, 0)::text || ')';
  ELSIF TG_TABLE_NAME = 'payroll_remittance_payments' THEN
    v_org_id := COALESCE(NEW.organization_id, OLD.organization_id);
    v_entity_name := COALESCE(NEW.reference_number, OLD.reference_number,
                              COALESCE(NEW.authority_name, OLD.authority_name) || ' ' ||
                              to_char(COALESCE(NEW.payment_date, OLD.payment_date), 'YYYY-MM-DD'));
    IF TG_OP = 'UPDATE' THEN
      v_old := jsonb_build_object('status', OLD.status, 'reversed_at', OLD.reversed_at,
                                  'journal_entry_id', OLD.journal_entry_id);
      v_new := jsonb_build_object('status', NEW.status, 'reversed_at', NEW.reversed_at,
                                  'journal_entry_id', NEW.journal_entry_id);
      v_summary := COALESCE(OLD.status, '∅') || ' → ' || COALESCE(NEW.status, '∅');
    ELSE
      v_new := jsonb_build_object('status', NEW.status, 'total_amount', NEW.total_amount,
                                  'journal_entry_id', NEW.journal_entry_id);
      v_summary := 'recorded (' || COALESCE(NEW.status, 'posted') || ', ' || NEW.total_amount::text || ')';
    END IF;
  ELSE
    RETURN NEW;
  END IF;

  INSERT INTO public.audit_logs (
    organization_id, user_id, action, entity_type, entity_id, entity_name,
    old_values, new_values, changes_summary
  ) VALUES (
    v_org_id, auth.uid(),
    CASE WHEN TG_OP = 'INSERT' THEN 'create' ELSE 'update' END,
    v_entity_type, COALESCE(NEW.id, OLD.id), v_entity_name,
    v_old, v_new, v_summary
  );

  RETURN NEW;
END;
$$;

-- 3. Attach triggers --------------------------------------------------
DROP TRIGGER IF EXISTS trg_audit_payroll_run_insert ON public.payroll_runs;
CREATE TRIGGER trg_audit_payroll_run_insert
  AFTER INSERT ON public.payroll_runs
  FOR EACH ROW EXECUTE FUNCTION public.log_payroll_audit('payroll_run');

DROP TRIGGER IF EXISTS trg_audit_payroll_run_update ON public.payroll_runs;
CREATE TRIGGER trg_audit_payroll_run_update
  AFTER UPDATE ON public.payroll_runs
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status
     OR OLD.posted_at IS DISTINCT FROM NEW.posted_at
     OR OLD.approved_at IS DISTINCT FROM NEW.approved_at
     OR OLD.reversed_at IS DISTINCT FROM NEW.reversed_at)
  EXECUTE FUNCTION public.log_payroll_audit('payroll_run');

DROP TRIGGER IF EXISTS trg_audit_payslip_update ON public.payslips;
CREATE TRIGGER trg_audit_payslip_update
  AFTER UPDATE ON public.payslips
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status
     OR OLD.paid_at IS DISTINCT FROM NEW.paid_at)
  EXECUTE FUNCTION public.log_payroll_audit('payslip');

DROP TRIGGER IF EXISTS trg_audit_payroll_liability_update ON public.payroll_liabilities;
CREATE TRIGGER trg_audit_payroll_liability_update
  AFTER UPDATE ON public.payroll_liabilities
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status
     OR OLD.paid_amount IS DISTINCT FROM NEW.paid_amount
     OR OLD.outstanding_amount IS DISTINCT FROM NEW.outstanding_amount)
  EXECUTE FUNCTION public.log_payroll_audit('payroll_liability');

DROP TRIGGER IF EXISTS trg_audit_remittance_payment_insert ON public.payroll_remittance_payments;
CREATE TRIGGER trg_audit_remittance_payment_insert
  AFTER INSERT ON public.payroll_remittance_payments
  FOR EACH ROW EXECUTE FUNCTION public.log_payroll_audit('payroll_remittance_payment');

DROP TRIGGER IF EXISTS trg_audit_remittance_payment_update ON public.payroll_remittance_payments;
CREATE TRIGGER trg_audit_remittance_payment_update
  AFTER UPDATE ON public.payroll_remittance_payments
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status
     OR OLD.reversed_at IS DISTINCT FROM NEW.reversed_at)
  EXECUTE FUNCTION public.log_payroll_audit('payroll_remittance_payment');

COMMENT ON FUNCTION public.log_payroll_audit() IS
  'R2 audit trail: writes status/amount transitions on payroll_runs, payslips, payroll_liabilities, and payroll_remittance_payments to audit_logs. Subset jsonb (not full row diffs) to keep audit_logs lean.';
COMMENT ON FUNCTION public.payroll_run_validate_schedule() IS
  'R2: validates a payroll run against its linked pay_schedule (business match, payment_date >= period_end + payment_offset_days). Skipped when pay_schedule_id is NULL for legacy compatibility.';
