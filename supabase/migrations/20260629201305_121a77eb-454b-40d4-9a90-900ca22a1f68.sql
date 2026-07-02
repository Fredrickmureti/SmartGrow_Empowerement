-- =========================================================================
-- Phase 4 P3 — Correction visibility
-- =========================================================================

-- 1. Link columns on payslips ------------------------------------------------
ALTER TABLE public.payslips
  ADD COLUMN IF NOT EXISTS corrects_payslip_id uuid
    REFERENCES public.payslips(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS superseded_by_payslip_id uuid
    REFERENCES public.payslips(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.payslips.corrects_payslip_id IS
  'Phase 4 P3: when this payslip is part of a reversal/correction run, points to the original payslip it cancels out. NULL for normal payslips.';
COMMENT ON COLUMN public.payslips.superseded_by_payslip_id IS
  'Phase 4 P3: when this payslip has been reversed/corrected, points forward to the reversal payslip that replaced it. NULL while still authoritative.';

CREATE INDEX IF NOT EXISTS idx_payslips_corrects
  ON public.payslips(corrects_payslip_id)
  WHERE corrects_payslip_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payslips_superseded_by
  ON public.payslips(superseded_by_payslip_id)
  WHERE superseded_by_payslip_id IS NOT NULL;

-- 2. Rewrite reversal RPC ---------------------------------------------------
-- Previous version referenced columns dropped in Phase 4 P1.2
-- (basic_salary, other_earnings, other_deductions). Rewriting to:
--   * use only universal totals on the payslips header
--   * set both ends of the correction link in the same transaction
--   * emit append-only lifecycle events (P2 journal)
CREATE OR REPLACE FUNCTION public.payroll_reverse_run_atomic(
  _run_id uuid,
  _user_id uuid,
  _reason text,
  _post_to_gl boolean DEFAULT true,
  _reversal_date date DEFAULT NULL::date
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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
  link_row         record;
BEGIN
  IF _run_id IS NULL THEN
    RAISE EXCEPTION 'run_id is required' USING ERRCODE = '22023';
  END IF;
  IF COALESCE(btrim(_reason), '') = '' OR length(btrim(_reason)) < 10 THEN
    RAISE EXCEPTION 'A reversal reason of at least 10 characters is required'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO r FROM public.payroll_runs WHERE id = _run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payroll run not found' USING ERRCODE = 'P0002';
  END IF;

  PERFORM public.assert_can_reverse_payroll(r.organization_id, _user_id);

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

  -- Country-agnostic payslip negation: only the universal totals + jsonb
  -- breakdowns survived Phase 4 P1.2. Statutory column-per-deduction is gone.
  WITH inserted AS (
    INSERT INTO public.payslips (
      payroll_run_id, employee_id, organization_id, business_id, branch_id,
      gross_pay, total_deductions, net_pay,
      status, paid_at,
      deductions_detail, contributions_detail,
      taxable_income, currency, corrects_payslip_id
    )
    SELECT
      rev_run_id, ps.employee_id, ps.organization_id, ps.business_id, ps.branch_id,
      -COALESCE(ps.gross_pay, 0),
      -COALESCE(ps.total_deductions, 0),
      -COALESCE(ps.net_pay, 0),
      'paid', now(),
      (SELECT COALESCE(jsonb_object_agg(k, CASE WHEN jsonb_typeof(v)='number' THEN to_jsonb(-(v#>>'{}')::numeric) ELSE v END), '{}'::jsonb)
         FROM jsonb_each(COALESCE(ps.deductions_detail, '{}'::jsonb)) AS e(k,v)),
      (SELECT COALESCE(jsonb_object_agg(k, CASE WHEN jsonb_typeof(v)='number' THEN to_jsonb(-(v#>>'{}')::numeric) ELSE v END), '{}'::jsonb)
         FROM jsonb_each(COALESCE(ps.contributions_detail, '{}'::jsonb)) AS e(k,v)),
      -COALESCE(ps.taxable_income, 0),
      ps.currency,
      ps.id
    FROM public.payslips ps
    WHERE ps.payroll_run_id = _run_id
    RETURNING id AS reversal_id, corrects_payslip_id AS original_id
  )
  UPDATE public.payslips orig
     SET superseded_by_payslip_id = ins.reversal_id
    FROM inserted ins
   WHERE orig.id = ins.original_id;

  GET DIAGNOSTICS ps_count = ROW_COUNT;

  IF ps_count = 0 THEN
    RAISE EXCEPTION 'No payslips found on original run %', r.payroll_number
      USING ERRCODE = '22023', HINT = 'NO_PAYSLIPS';
  END IF;

  -- Lifecycle journal: original got superseded, reversal records correction
  FOR link_row IN
    SELECT id, superseded_by_payslip_id
      FROM public.payslips
     WHERE payroll_run_id = _run_id
       AND superseded_by_payslip_id IS NOT NULL
  LOOP
    PERFORM public.emit_payslip_event(
      link_row.id,
      'superseded'::public.payslip_event_type,
      jsonb_build_object(
        'superseded_by_payslip_id', link_row.superseded_by_payslip_id,
        'reversal_run_id', rev_run_id,
        'reason', _reason
      )
    );
    PERFORM public.emit_payslip_event(
      link_row.superseded_by_payslip_id,
      'corrected'::public.payslip_event_type,
      jsonb_build_object(
        'corrects_payslip_id', link_row.id,
        'original_run_id', _run_id,
        'reason', _reason
      )
    );
  END LOOP;

  UPDATE public.payroll_runs
     SET status          = 'reversed',
         reversed_at     = now(),
         reversed_by     = _user_id,
         reversal_reason = _reason
   WHERE id = _run_id;

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
$function$;

-- 3. Integrity guard: original cannot remain "paid" if successor not posted -
CREATE OR REPLACE FUNCTION public.assert_superseded_payslip_consistency()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  succ_status text;
BEGIN
  IF NEW.superseded_by_payslip_id IS NOT NULL AND NEW.status = 'paid' THEN
    SELECT status INTO succ_status
      FROM public.payslips
     WHERE id = NEW.superseded_by_payslip_id;
    IF succ_status IS NULL OR succ_status NOT IN ('posted','paid') THEN
      RAISE EXCEPTION
        'Payslip % cannot remain paid while its successor % has status %',
        NEW.id, NEW.superseded_by_payslip_id, COALESCE(succ_status, 'missing')
        USING ERRCODE = '22023', HINT = 'CORRECTION_INCONSISTENT';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_assert_superseded_payslip_consistency ON public.payslips;
CREATE TRIGGER trg_assert_superseded_payslip_consistency
  BEFORE UPDATE OF status, superseded_by_payslip_id ON public.payslips
  FOR EACH ROW
  EXECUTE FUNCTION public.assert_superseded_payslip_consistency();