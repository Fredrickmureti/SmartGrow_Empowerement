
-- Stage 6/7: Loan engine alignment + timesheet payroll lock + GL mapping for loan repayments

-- 6.1 Rewrite process_payroll_loan_deductions to consume schedule + per-loan-type rule codes
CREATE OR REPLACE FUNCTION public.process_payroll_loan_deductions(
  _payroll_run_id uuid,
  _payroll_number text,
  _deductions jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _ld jsonb;
  _loan record;
  _amount numeric;
  _payslip_id uuid;
  _remaining numeric;
  _sched record;
  _alloc numeric;
  _new_repaid numeric;
  _new_balance numeric;
  _repayment_id uuid;
BEGIN
  FOR _ld IN SELECT * FROM jsonb_array_elements(_deductions)
  LOOP
    _amount    := COALESCE((_ld->>'amount')::numeric, 0);
    _payslip_id := NULLIF(_ld->>'payslip_id','')::uuid;
    IF _amount <= 0 THEN CONTINUE; END IF;

    SELECT id, total_amount, amount_repaid, installments_paid, total_installments, outstanding_balance, repayment_method
      INTO _loan
      FROM employee_loans
     WHERE id = (_ld->>'loan_id')::uuid
     FOR UPDATE;
    IF _loan.id IS NULL THEN
      RAISE EXCEPTION 'Loan % not found', _ld->>'loan_id';
    END IF;

    -- Insert repayment ledger row
    INSERT INTO loan_repayments (loan_id, payroll_run_id, payslip_id, amount, installment_number, notes)
    VALUES (
      _loan.id, _payroll_run_id, _payslip_id, _amount,
      COALESCE(_loan.installments_paid,0) + 1,
      'Auto-deducted via payroll ' || COALESCE(_payroll_number,'')
    )
    RETURNING id INTO _repayment_id;

    -- Allocate against schedule rows (FIFO) when one exists
    _remaining := _amount;
    FOR _sched IN
      SELECT id, scheduled_amount, paid_amount
        FROM loan_repayment_schedule
       WHERE loan_id = _loan.id
         AND status IN ('pending','partial')
       ORDER BY sequence
       FOR UPDATE
    LOOP
      EXIT WHEN _remaining <= 0;
      _alloc := LEAST(_remaining, GREATEST(_sched.scheduled_amount - COALESCE(_sched.paid_amount,0), 0));
      IF _alloc <= 0 THEN CONTINUE; END IF;
      UPDATE loan_repayment_schedule
         SET paid_amount = COALESCE(paid_amount,0) + _alloc,
             status = CASE
               WHEN COALESCE(paid_amount,0) + _alloc >= scheduled_amount THEN 'paid'
               ELSE 'partial'
             END,
             payslip_id = COALESCE(payslip_id, _payslip_id),
             repayment_id = COALESCE(repayment_id, _repayment_id),
             updated_at = now()
       WHERE id = _sched.id;
      _remaining := _remaining - _alloc;
    END LOOP;

    -- Update loan running totals
    _new_repaid  := COALESCE(_loan.amount_repaid,0) + _amount;
    _new_balance := GREATEST(_loan.total_amount - _new_repaid, 0);
    UPDATE employee_loans
       SET amount_repaid       = _new_repaid,
           outstanding_balance = _new_balance,
           installments_paid   = COALESCE(installments_paid,0) + 1,
           status = CASE
             WHEN _new_balance <= 0 THEN 'settled'
             ELSE status
           END,
           updated_at = now()
     WHERE id = _loan.id;
  END LOOP;
END;
$$;

-- 6.4 Extend GL mapping resolver to surface per-loan-type repayment payable accounts
CREATE OR REPLACE FUNCTION public.payroll_required_gl_mappings_for_run(p_run_id uuid)
RETURNS TABLE(setting_key text, label text, rule_code text, kind text, required_account_type text, is_mapped boolean, suggested_account_id uuid, suggested_account_label text)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_run public.payroll_runs%ROWTYPE;
BEGIN
  SELECT * INTO v_run FROM public.payroll_runs WHERE id = p_run_id;
  IF NOT FOUND THEN RETURN; END IF;

  IF auth.uid() IS NOT NULL
     AND NOT public.is_org_member(auth.uid(), v_run.organization_id) THEN
    RAISE EXCEPTION 'Not authorized to inspect this payroll run' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH agg AS (
    SELECT
      pl.rule_code,
      MAX(COALESCE(pl.label, pl.rule_code)) AS label,
      BOOL_OR(pl.category::text IN (
        'deduction','statutory_employee','tax',
        'loan_repayment','benefit_recovery','benefit'
      ) AND COALESCE(pl.employee_amount,0) > 0) AS has_employee,
      BOOL_OR(pl.category::text IN (
        'employer_contribution','statutory_employer'
      ) AND COALESCE(pl.employer_amount,0) > 0) AS has_employer
    FROM public.payslip_lines pl
    WHERE pl.payroll_run_id = p_run_id
      AND pl.rule_code IS NOT NULL
      AND pl.category::text <> 'earning'
    GROUP BY pl.rule_code
  ),
  active_loan_types AS (
    SELECT DISTINCT lt.code AS rule_code,
           COALESCE(lt.salary_rule_code, 'loan_repayment_' || lower(lt.code)) AS effective_code,
           lt.name AS label
      FROM public.employee_loans el
      JOIN public.loan_types lt ON lt.id = el.loan_type_id
     WHERE el.organization_id = v_run.organization_id
       AND (v_run.business_id IS NULL OR el.business_id = v_run.business_id)
       AND el.status = 'active'
       AND el.start_date <= v_run.pay_period_end
  ),
  needed AS (
    SELECT 'salary_expense'::text AS setting_key, 'Salary Expense'::text AS label,
           NULL::text AS rule_code, 'core'::text AS kind, 'expense'::text AS required_account_type
    UNION ALL
    SELECT 'net_salary_payable', 'Net Salary Payable', NULL, 'core', 'liability'
    UNION ALL
    SELECT a.rule_code || '_payable',
           COALESCE(a.label, a.rule_code) || ' — Payable',
           a.rule_code, 'employee_payable', 'liability'
    FROM agg a WHERE a.has_employee
    UNION ALL
    SELECT a.rule_code || '_employer_expense',
           COALESCE(a.label, a.rule_code) || ' — Employer Expense',
           a.rule_code, 'employer_expense', 'expense'
    FROM agg a WHERE a.has_employer
    UNION ALL
    SELECT a.rule_code || '_payable',
           COALESCE(a.label, a.rule_code) || ' — Payable',
           a.rule_code, 'employer_payable', 'liability'
    FROM agg a WHERE a.has_employer AND NOT a.has_employee
    UNION ALL
    SELECT lt.effective_code || '_payable',
           lt.label || ' — Loan Receivable',
           lt.effective_code, 'loan_receivable', 'asset'
    FROM active_loan_types lt
  ),
  needed_dedup AS (
    SELECT DISTINCT ON (n.setting_key)
      n.setting_key, n.label, n.rule_code, n.kind, n.required_account_type
    FROM needed n
    ORDER BY n.setting_key,
             CASE n.kind WHEN 'core' THEN 0
                         WHEN 'employee_payable' THEN 1
                         WHEN 'employer_expense' THEN 2
                         WHEN 'loan_receivable' THEN 4
                         ELSE 3 END
  ),
  effective_mappings AS (
    SELECT DISTINCT ON (das.setting_key)
      das.setting_key, das.account_id
    FROM public.default_account_settings das
    WHERE das.organization_id = v_run.organization_id
      AND (v_run.business_id IS NULL
           OR das.business_id IS NULL
           OR das.business_id = v_run.business_id)
    ORDER BY das.setting_key, (das.business_id IS NOT NULL) DESC
  ),
  candidates AS (
    SELECT a.id, a.code, a.name, a.account_type::text AS account_type
    FROM public.accounts a
    WHERE a.organization_id = v_run.organization_id
      AND COALESCE(a.is_active, true) = true
      AND COALESCE(a.is_header, false) = false
      AND (v_run.business_id IS NULL
           OR a.business_id IS NULL
           OR a.business_id = v_run.business_id)
  ),
  ranked AS (
    SELECT n.setting_key, c.id AS account_id,
           ROW_NUMBER() OVER (
             PARTITION BY n.setting_key
             ORDER BY
               CASE WHEN n.rule_code IS NOT NULL
                         AND (lower(c.name) ILIKE '%'||replace(n.rule_code,'_',' ')||'%'
                              OR lower(c.code) ILIKE '%'||lower(n.rule_code)||'%')
                    THEN 0
                    WHEN lower(c.name) ILIKE '%'||lower(replace(n.setting_key,'_',' '))||'%'
                    THEN 1
                    ELSE 2
               END,
               c.code
           ) AS rn
    FROM needed_dedup n
    JOIN candidates c ON c.account_type = n.required_account_type
  ),
  suggestions AS (
    SELECT r.setting_key, r.account_id FROM ranked r WHERE r.rn = 1
  )
  SELECT
    n.setting_key, n.label, n.rule_code, n.kind, n.required_account_type,
    (em.account_id IS NOT NULL) AS is_mapped,
    CASE WHEN em.account_id IS NULL THEN s.account_id END AS suggested_account_id,
    CASE WHEN em.account_id IS NULL THEN
      (SELECT a.code || ' — ' || a.name FROM public.accounts a WHERE a.id = s.account_id)
    END AS suggested_account_label
  FROM needed_dedup n
  LEFT JOIN effective_mappings em ON em.setting_key = n.setting_key
  LEFT JOIN suggestions s ON s.setting_key = n.setting_key
  ORDER BY n.kind, n.setting_key;
END;
$$;

-- 7. Lock timesheets when a payroll run is posted
CREATE OR REPLACE FUNCTION public.tg_lock_timesheets_on_payroll_post()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'posted' AND COALESCE(OLD.status,'') <> 'posted' THEN
    UPDATE public.timesheets
       SET payroll_locked = true,
           payroll_locked_at = COALESCE(payroll_locked_at, now())
     WHERE organization_id = NEW.organization_id
       AND (NEW.business_id IS NULL OR business_id = NEW.business_id)
       AND status = 'approved'
       AND date BETWEEN NEW.pay_period_start AND NEW.pay_period_end
       AND payroll_locked = false;
    UPDATE public.timesheet_submissions
       SET payroll_locked_at = COALESCE(payroll_locked_at, now())
     WHERE organization_id = NEW.organization_id
       AND (NEW.business_id IS NULL OR business_id = NEW.business_id)
       AND status = 'approved'
       AND period_start <= NEW.pay_period_end
       AND period_end   >= NEW.pay_period_start
       AND payroll_locked_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS lock_timesheets_on_payroll_post ON public.payroll_runs;
CREATE TRIGGER lock_timesheets_on_payroll_post
AFTER UPDATE OF status ON public.payroll_runs
FOR EACH ROW
EXECUTE FUNCTION public.tg_lock_timesheets_on_payroll_post();

-- 7b. Block mutation of timesheets that are payroll-locked (admins may unlock first via RPC)
CREATE OR REPLACE FUNCTION public.tg_prevent_locked_timesheet_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF COALESCE(OLD.payroll_locked, false) THEN
      RAISE EXCEPTION 'Timesheet is locked by a posted payroll run and cannot be deleted'
        USING ERRCODE = '55006';
    END IF;
    RETURN OLD;
  END IF;
  -- UPDATE: allow flipping the lock itself (admins via RPC), block other edits
  IF COALESCE(OLD.payroll_locked, false)
     AND COALESCE(NEW.payroll_locked, false) THEN
    -- Only allow trivial timestamp/lock-related updates while locked
    IF NEW.hours       IS DISTINCT FROM OLD.hours
    OR NEW.date        IS DISTINCT FROM OLD.date
    OR NEW.project_id  IS DISTINCT FROM OLD.project_id
    OR NEW.task_id     IS DISTINCT FROM OLD.task_id
    OR NEW.start_time  IS DISTINCT FROM OLD.start_time
    OR NEW.end_time    IS DISTINCT FROM OLD.end_time
    OR NEW.is_billable IS DISTINCT FROM OLD.is_billable
    OR NEW.billing_rate IS DISTINCT FROM OLD.billing_rate THEN
      RAISE EXCEPTION 'Timesheet is locked by a posted payroll run and cannot be edited. An administrator must unlock the period first.'
        USING ERRCODE = '55006';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS prevent_locked_timesheet_mutation ON public.timesheets;
CREATE TRIGGER prevent_locked_timesheet_mutation
BEFORE UPDATE OR DELETE ON public.timesheets
FOR EACH ROW
EXECUTE FUNCTION public.tg_prevent_locked_timesheet_mutation();

-- Drop the legacy CHECK constraint on employee_loans.loan_type so dynamic loan types
-- (e.g., EMERGENCY, ASSET) no longer fail inserts. The text column is kept for
-- backward compatibility until UI is fully migrated to loan_type_id.
DO $$
DECLARE c text;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'public.employee_loans'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%loan_type%'
  LOOP
    EXECUTE format('ALTER TABLE public.employee_loans DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
