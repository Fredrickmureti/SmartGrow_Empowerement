
-- 1. Backfill: historical reversed runs were left in posted/paid status
UPDATE public.payroll_runs
   SET status = 'reversed'
 WHERE reversed_at IS NOT NULL
   AND status IN ('posted','paid')
   AND is_reversal = false;

-- 2. Structural guarantee: at most one reversal sub-ledger per parent
CREATE UNIQUE INDEX IF NOT EXISTS payroll_runs_one_reversal_per_parent
  ON public.payroll_runs(original_run_id)
  WHERE is_reversal = true;

-- 3. Harden paid-path guard:
--    a) Allow INSERTs of reversal rows with status='paid' (the only legit
--       non-batch path to land a paid row).
--    b) Reject any UPDATE that tries to move a 'reversed' row back to a
--       reversible status.
CREATE OR REPLACE FUNCTION public.payroll_runs_paid_path_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = 'public'
AS $function$
BEGIN
  IF TG_OP = 'UPDATE'
     AND COALESCE(OLD.status,'') = 'reversed'
     AND COALESCE(NEW.status,'') <> 'reversed' THEN
    RAISE EXCEPTION 'Cannot move a reversed payroll run back to %', NEW.status
      USING ERRCODE = '42501', HINT = 'payroll_reversed_terminal';
  END IF;

  IF TG_OP = 'INSERT' AND NEW.status = 'paid' THEN
    IF COALESCE(NEW.is_reversal, false) = true THEN
      RETURN NEW;
    END IF;
    IF auth.role() = 'service_role'
       OR COALESCE(current_setting('app.payroll_payment_via_batch', true), '') = 'on' THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION
      'Payroll runs can only be marked paid via the payment-batch posting path (post-payroll-payment-gl) or via an atomic reversal.'
      USING ERRCODE = '42501', HINT = 'payroll_paid_bypass_blocked';
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.status = 'paid' AND COALESCE(OLD.status,'') <> 'paid' THEN
    IF auth.role() = 'service_role'
       OR COALESCE(current_setting('app.payroll_payment_via_batch', true), '') = 'on' THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION
      'Payroll runs can only be marked paid via the payment-batch posting path (post-payroll-payment-gl). Direct status updates are forbidden.'
      USING ERRCODE = '42501', HINT = 'payroll_paid_bypass_blocked';
  END IF;

  RETURN NEW;
END;
$function$;

-- Re-bind: the existing trigger was BEFORE UPDATE OF status only.
-- We need to fire on INSERT as well so the relaxed reversal-insert rule
-- and the terminal-state check both apply.
DROP TRIGGER IF EXISTS trg_payroll_runs_paid_path_guard ON public.payroll_runs;
CREATE TRIGGER trg_payroll_runs_paid_path_guard
  BEFORE INSERT OR UPDATE OF status ON public.payroll_runs
  FOR EACH ROW
  EXECUTE FUNCTION public.payroll_runs_paid_path_guard();

-- 4. Reversibility predicate (used by UI + preview RPC)
CREATE OR REPLACE FUNCTION public.payroll_run_can_reverse(_run_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  r public.payroll_runs%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.payroll_runs WHERE id = _run_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('can_reverse', false, 'reason', 'NOT_FOUND');
  END IF;
  IF r.is_reversal = true THEN
    RETURN jsonb_build_object('can_reverse', false, 'reason', 'IS_REVERSAL');
  END IF;
  IF r.status = 'reversed' OR r.reversed_at IS NOT NULL THEN
    RETURN jsonb_build_object('can_reverse', false, 'reason', 'ALREADY_REVERSED');
  END IF;
  IF r.status NOT IN ('posted','paid') THEN
    RETURN jsonb_build_object('can_reverse', false, 'reason', 'INVALID_STATE', 'status', r.status);
  END IF;
  RETURN jsonb_build_object('can_reverse', true);
END;
$$;

-- 5. The atomic reversal RPC.
--    Replaces the multi-step edge function flow with a single transaction.
CREATE OR REPLACE FUNCTION public.payroll_reverse_run_atomic(
  _run_id uuid,
  _user_id uuid,
  _reason text,
  _post_to_gl boolean DEFAULT true,
  _reversal_date date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  r                public.payroll_runs%ROWTYPE;
  existing_rev_id  uuid;
  existing_rev_num text;
  rev_number       text;
  rev_run_id       uuid;
  base_number      text;
  suffix_n         int := 0;
  original_je      record;
  gl_reversal_id   uuid;
  gl_result        jsonb;
  ps_count         int;
  rev_date         date := COALESCE(_reversal_date, CURRENT_DATE);
BEGIN
  IF _run_id IS NULL THEN
    RAISE EXCEPTION 'run_id is required' USING ERRCODE = '22023';
  END IF;
  IF COALESCE(btrim(_reason), '') = '' OR length(btrim(_reason)) < 10 THEN
    RAISE EXCEPTION 'A reversal reason of at least 10 characters is required'
      USING ERRCODE = '22023';
  END IF;

  -- Lock the original row
  SELECT * INTO r FROM public.payroll_runs WHERE id = _run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payroll run not found' USING ERRCODE = 'P0002';
  END IF;

  -- Idempotency: already reversed → return existing envelope
  IF r.status = 'reversed' OR r.reversed_at IS NOT NULL THEN
    SELECT id, payroll_number INTO existing_rev_id, existing_rev_num
      FROM public.payroll_runs
     WHERE original_run_id = _run_id AND is_reversal = true
     LIMIT 1;
    RETURN jsonb_build_object(
      'idempotent', true,
      'reversal_run_id', existing_rev_id,
      'reversal_number', existing_rev_num,
      'original_run_id', _run_id,
      'gl_result', jsonb_build_object('idempotent', true)
    );
  END IF;

  -- State guard
  IF r.is_reversal = true THEN
    RAISE EXCEPTION 'A reversal run cannot itself be reversed'
      USING ERRCODE = '22023', HINT = 'IS_REVERSAL';
  END IF;
  IF r.run_type = 'correction' THEN
    RAISE EXCEPTION 'Correction runs cannot be reversed through this path'
      USING ERRCODE = '22023', HINT = 'INVALID_STATE';
  END IF;
  IF r.status NOT IN ('posted','paid') THEN
    RAISE EXCEPTION 'Only paid or posted payroll runs can be reversed (current: %)', r.status
      USING ERRCODE = '22023', HINT = 'INVALID_STATE';
  END IF;

  -- Allocate a non-colliding reversal number. The suffix is part of the
  -- uniqueness scan so retries cannot collide.
  base_number := r.payroll_number || '-REV';
  rev_number  := base_number;
  WHILE EXISTS (
    SELECT 1 FROM public.payroll_runs
     WHERE organization_id = r.organization_id
       AND payroll_number  = rev_number
  ) LOOP
    suffix_n := suffix_n + 1;
    rev_number := base_number || '-' || suffix_n;
  END LOOP;

  -- Insert reversal sub-ledger run with negated totals
  INSERT INTO public.payroll_runs (
    organization_id, business_id, branch_id,
    payroll_number, pay_period_start, pay_period_end, payment_date,
    status, total_gross, total_other_deductions, total_net,
    total_employer_contributions,
    employee_count, notes, approved_by, approved_at, created_by,
    is_reversal, original_run_id, parent_run_id, run_type,
    deductions_summary, contributions_summary
  ) VALUES (
    r.organization_id, r.business_id, r.branch_id,
    rev_number, r.pay_period_start, r.pay_period_end, rev_date,
    'paid',
    -COALESCE(r.total_gross, 0),
    -COALESCE(r.total_other_deductions, 0),
    -COALESCE(r.total_net, 0),
    -COALESCE(r.total_employer_contributions, 0),
    r.employee_count,
    'Reversal of ' || r.payroll_number || ': ' || _reason,
    _user_id, now(), _user_id,
    true, r.id, r.id, 'correction',
    (
      SELECT COALESCE(jsonb_object_agg(k, CASE WHEN jsonb_typeof(v)='number' THEN to_jsonb(-(v#>>'{}')::numeric) ELSE v END), '{}'::jsonb)
        FROM jsonb_each(COALESCE(r.deductions_summary, '{}'::jsonb)) AS e(k,v)
    ),
    (
      SELECT COALESCE(jsonb_object_agg(k, CASE WHEN jsonb_typeof(v)='number' THEN to_jsonb(-(v#>>'{}')::numeric) ELSE v END), '{}'::jsonb)
        FROM jsonb_each(COALESCE(r.contributions_summary, '{}'::jsonb)) AS e(k,v)
    )
  )
  RETURNING id INTO rev_run_id;

  -- Negate payslips in one set-based insert
  INSERT INTO public.payslips (
    payroll_run_id, employee_id, organization_id, business_id, branch_id,
    basic_salary, other_earnings, gross_pay,
    other_deductions, total_deductions, net_pay,
    status, paid_at,
    deductions_detail, contributions_detail,
    taxable_income
  )
  SELECT
    rev_run_id, ps.employee_id, ps.organization_id, ps.business_id, ps.branch_id,
    -COALESCE(ps.basic_salary, 0),
    (SELECT COALESCE(jsonb_object_agg(k, CASE WHEN jsonb_typeof(v)='number' THEN to_jsonb(-(v#>>'{}')::numeric) ELSE v END), '{}'::jsonb)
       FROM jsonb_each(COALESCE(ps.other_earnings, '{}'::jsonb)) AS e(k,v)),
    -COALESCE(ps.gross_pay, 0),
    (SELECT COALESCE(jsonb_object_agg(k, CASE WHEN jsonb_typeof(v)='number' THEN to_jsonb(-(v#>>'{}')::numeric) ELSE v END), '{}'::jsonb)
       FROM jsonb_each(COALESCE(ps.other_deductions, '{}'::jsonb)) AS e(k,v)),
    -COALESCE(ps.total_deductions, 0),
    -COALESCE(ps.net_pay, 0),
    'paid', now(),
    (SELECT COALESCE(jsonb_object_agg(k, CASE WHEN jsonb_typeof(v)='number' THEN to_jsonb(-(v#>>'{}')::numeric) ELSE v END), '{}'::jsonb)
       FROM jsonb_each(COALESCE(ps.deductions_detail, '{}'::jsonb)) AS e(k,v)),
    (SELECT COALESCE(jsonb_object_agg(k, CASE WHEN jsonb_typeof(v)='number' THEN to_jsonb(-(v#>>'{}')::numeric) ELSE v END), '{}'::jsonb)
       FROM jsonb_each(COALESCE(ps.contributions_detail, '{}'::jsonb)) AS e(k,v)),
    -COALESCE(ps.taxable_income, 0)
  FROM public.payslips ps
  WHERE ps.payroll_run_id = _run_id;

  GET DIAGNOSTICS ps_count = ROW_COUNT;

  IF ps_count = 0 THEN
    RAISE EXCEPTION 'No payslips found on original run %', r.payroll_number
      USING ERRCODE = '22023', HINT = 'NO_PAYSLIPS';
  END IF;

  -- Mark the original as terminally reversed
  UPDATE public.payroll_runs
     SET status          = 'reversed',
         reversed_at     = now(),
         reversed_by     = _user_id,
         reversal_reason = _reason
   WHERE id = _run_id;

  -- GL reversal via canonical idempotent path
  gl_result := jsonb_build_object('skipped', true, 'reason', 'post_to_gl=false');
  IF _post_to_gl THEN
    SELECT id, status INTO original_je
      FROM public.journal_entries
     WHERE organization_id = r.organization_id
       AND source_type = 'payroll'
       AND source_id   = _run_id
       AND status NOT IN ('voided','reversed')
     LIMIT 1;

    IF original_je.id IS NULL THEN
      IF r.status = 'posted' THEN
        RAISE EXCEPTION 'Original payroll run % was marked posted but has no live GL journal entry to reverse', r.payroll_number
          USING ERRCODE = '22023', HINT = 'MISSING_GL_ENTRY';
      END IF;
      gl_result := jsonb_build_object('skipped', true, 'reason', 'no_gl_entry');
    ELSE
      SELECT public.void_journal_entry_atomic(
        original_je.id,
        'Payroll reversal ' || rev_number || ': ' || _reason,
        _user_id,
        NULL,
        rev_date
      ) INTO gl_reversal_id;

      gl_result := jsonb_build_object(
        'original_journal_entry_id', original_je.id,
        'reversal_journal_entry_id', gl_reversal_id
      );
    END IF;
  END IF;

  -- Audit (last statement: commits with the rest)
  INSERT INTO public.audit_logs (
    organization_id, business_id, user_id, action,
    entity_type, entity_id, entity_name,
    new_values, changes_summary
  ) VALUES (
    r.organization_id, r.business_id, _user_id, 'reversed',
    'payroll_run', _run_id, r.payroll_number,
    jsonb_build_object(
      'reversal_run_id', rev_run_id,
      'reversal_number', rev_number,
      'reason', _reason,
      'gl_result', gl_result
    ),
    'Reversed payroll ' || r.payroll_number || '. Reversal: ' || rev_number || '. Reason: ' || _reason
  );

  RETURN jsonb_build_object(
    'idempotent', false,
    'reversal_run_id', rev_run_id,
    'reversal_number', rev_number,
    'original_run_id', _run_id,
    'payslips_reversed', ps_count,
    'gl_result', gl_result
  );
END;
$$;

REVOKE ALL ON FUNCTION public.payroll_reverse_run_atomic(uuid, uuid, text, boolean, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.payroll_reverse_run_atomic(uuid, uuid, text, boolean, date) TO service_role;
GRANT EXECUTE ON FUNCTION public.payroll_run_can_reverse(uuid) TO authenticated, service_role;
