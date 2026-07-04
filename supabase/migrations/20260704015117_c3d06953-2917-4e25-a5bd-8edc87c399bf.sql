-- Phase E — DB-side enforcement of loan-type skip policy caps.
-- Runs on every INSERT into payroll_run_loan_skip_overrides so caps hold no
-- matter which code path submits the override (UI, RPC, batch import).
CREATE OR REPLACE FUNCTION public.loan_skip_overrides_enforce_policy()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lt          public.loan_types%ROWTYPE;
  v_used_total  integer;
  v_used_ytd    integer;
  v_last_period date;
  v_new_period  date;
  v_gap_days    integer;
BEGIN
  -- Load loan type via loan.
  SELECT lt.* INTO v_lt
  FROM public.employee_loans el
  JOIN public.loan_types lt ON lt.id = el.loan_type_id
  WHERE el.id = NEW.loan_id;

  IF v_lt.id IS NULL THEN
    -- No loan type resolvable → allow (nothing to enforce).
    RETURN NEW;
  END IF;

  -- 1. allow_skip
  IF COALESCE(v_lt.allow_skip, false) = false THEN
    RAISE EXCEPTION 'Loan type "%" does not permit skip overrides (allow_skip = false).', v_lt.code
      USING ERRCODE = 'check_violation';
  END IF;

  -- 2. max_skips_per_loan (count active + approved + consumed; ignore rejected/cancelled)
  IF v_lt.max_skips_per_loan IS NOT NULL AND v_lt.max_skips_per_loan >= 0 THEN
    SELECT count(*) INTO v_used_total
    FROM public.payroll_run_loan_skip_overrides
    WHERE loan_id = NEW.loan_id
      AND status IN ('pending','approved','consumed');
    IF v_used_total >= v_lt.max_skips_per_loan THEN
      RAISE EXCEPTION 'Loan skip cap reached: max % skip(s) per loan for loan type "%" (already used %).',
        v_lt.max_skips_per_loan, v_lt.code, v_used_total
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- 3. max_skips_per_calendar_year
  IF v_lt.max_skips_per_calendar_year IS NOT NULL AND v_lt.max_skips_per_calendar_year >= 0 THEN
    SELECT count(*) INTO v_used_ytd
    FROM public.payroll_run_loan_skip_overrides o
    WHERE o.loan_id = NEW.loan_id
      AND o.status IN ('pending','approved','consumed')
      AND date_part('year', o.created_at) = date_part('year', now());
    IF v_used_ytd >= v_lt.max_skips_per_calendar_year THEN
      RAISE EXCEPTION 'Annual loan skip cap reached: max % skip(s) per year for loan type "%" (used % this year).',
        v_lt.max_skips_per_calendar_year, v_lt.code, v_used_ytd
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- 4. min_gap_between_skips_days — compare new run's period_end to the last
  --    approved/consumed skip's run period_end.
  IF v_lt.min_gap_between_skips_days IS NOT NULL AND v_lt.min_gap_between_skips_days > 0 THEN
    SELECT pr.period_end INTO v_new_period
    FROM public.payroll_runs pr
    WHERE pr.id = NEW.payroll_run_id;

    SELECT max(pr2.period_end) INTO v_last_period
    FROM public.payroll_run_loan_skip_overrides o
    JOIN public.payroll_runs pr2 ON pr2.id = o.payroll_run_id
    WHERE o.loan_id = NEW.loan_id
      AND o.status IN ('approved','consumed');

    IF v_new_period IS NOT NULL AND v_last_period IS NOT NULL THEN
      v_gap_days := (v_new_period - v_last_period);
      IF v_gap_days < v_lt.min_gap_between_skips_days THEN
        RAISE EXCEPTION 'Loan skip gap too short: % day(s) since last skip, minimum is % for loan type "%".',
          v_gap_days, v_lt.min_gap_between_skips_days, v_lt.code
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_loan_skip_overrides_enforce_policy
  ON public.payroll_run_loan_skip_overrides;

CREATE TRIGGER trg_loan_skip_overrides_enforce_policy
  BEFORE INSERT ON public.payroll_run_loan_skip_overrides
  FOR EACH ROW
  EXECUTE FUNCTION public.loan_skip_overrides_enforce_policy();

COMMENT ON FUNCTION public.loan_skip_overrides_enforce_policy() IS
  'Phase E: enforces loan_types.{allow_skip, max_skips_per_loan, max_skips_per_calendar_year, min_gap_between_skips_days} on every skip override insertion.';
