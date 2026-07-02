
-- ============================================================================
-- Payroll reversal authorization fix
-- Root cause: service-role RPCs (reverse-payroll edge function) call
-- assert_can_void_je(), which read auth.uid() and raise 'Not authenticated'
-- (42501) even though the caller's id was already passed as _user_id.
-- ============================================================================

-- 1) Governance authority — "no impotent admin" rule, written once.
CREATE OR REPLACE FUNCTION public.is_governance_authority(
  _user_id uuid,
  _organization_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    _user_id IS NOT NULL
    AND (
      public.is_platform_admin(_user_id)
      OR EXISTS (
        SELECT 1
        FROM public.user_roles
        WHERE user_id = _user_id
          AND organization_id = _organization_id
          AND role IN ('super_admin','owner','admin')
      )
    );
$$;

GRANT EXECUTE ON FUNCTION public.is_governance_authority(uuid, uuid)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.is_governance_authority(uuid, uuid) IS
  'True if the user is a platform admin or holds owner/admin/super_admin in the organization. Used as the universal bypass for operational permission gates so governance authorities cannot be locked out of recovery operations (Odoo-aligned).';

-- 2) Overloaded gate helpers that accept an explicit caller.
--    The original 1-arg signatures are NOT dropped; they continue to be
--    called by RLS and by authenticated client RPCs and still read auth.uid().

CREATE OR REPLACE FUNCTION public.assert_can_void_je(
  _business_id uuid,
  _caller uuid
)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := COALESCE(_caller, auth.uid());
  v_org uuid;
  v_has_perm boolean := false;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Caller identity is required for journal entry void'
      USING ERRCODE = '42501', HINT = 'IDENTITY_REQUIRED';
  END IF;

  IF _business_id IS NOT NULL THEN
    SELECT b.organization_id INTO v_org
      FROM public.businesses b WHERE b.id = _business_id;

    IF v_org IS NOT NULL AND public.is_governance_authority(v_uid, v_org) THEN
      RETURN;
    END IF;
  END IF;

  SELECT public.has_finance_permission(v_uid, 'finance.void_je', _business_id)
    INTO v_has_perm;

  IF NOT COALESCE(v_has_perm, false) THEN
    RAISE EXCEPTION
      'INSUFFICIENT_PRIVILEGE_JE_VOID: user % lacks finance.void_je for business %',
      v_uid, _business_id
      USING ERRCODE = '42501', HINT = 'FINANCE_VOID_JE_FORBIDDEN';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.assert_can_void_je(uuid, uuid)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.assert_can_manage_je(
  _business_id uuid,
  _caller uuid
)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := COALESCE(_caller, auth.uid());
  v_org uuid;
  v_has_perm boolean := false;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Caller identity is required for journal entry management'
      USING ERRCODE = '42501', HINT = 'IDENTITY_REQUIRED';
  END IF;

  IF _business_id IS NOT NULL THEN
    SELECT b.organization_id INTO v_org
      FROM public.businesses b WHERE b.id = _business_id;

    IF v_org IS NOT NULL AND public.is_governance_authority(v_uid, v_org) THEN
      RETURN;
    END IF;
  END IF;

  SELECT public.has_finance_permission(v_uid, 'finance.manage_je', _business_id)
    INTO v_has_perm;

  IF NOT COALESCE(v_has_perm, false) THEN
    RAISE EXCEPTION
      'INSUFFICIENT_PRIVILEGE_JE_MANAGE: user % lacks finance.manage_je for business %',
      v_uid, _business_id
      USING ERRCODE = '42501', HINT = 'FINANCE_MANAGE_JE_FORBIDDEN';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.assert_can_manage_je(uuid, uuid)
  TO authenticated, service_role;

-- 3) Thread the verified caller through void_journal_entry_atomic.
--    Only the gate line changes; the rest of the function is preserved.
CREATE OR REPLACE FUNCTION public.void_journal_entry_atomic(
  _entry_id uuid,
  _reason text,
  _user_id uuid DEFAULT NULL::uuid,
  _entry_number text DEFAULT NULL::text,
  _reversal_date date DEFAULT NULL::date
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _original RECORD;
  _reversal_id uuid := gen_random_uuid();
  _line RECORD;
  _now timestamptz := now();
  _org_id uuid;
  _business_id uuid;
  _branch_id uuid;
  _final_entry_number text;
  _final_reversal_date date;
  _existing_reversal uuid;
  _reversal_subtype text;
  _is_org_admin boolean;
  _has_business_access boolean;
  _next_seq bigint;
BEGIN
  SELECT * INTO _original FROM journal_entries WHERE id = _entry_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Journal entry not found: %', _entry_id;
  END IF;

  -- Phase 7 gate — now accepts an explicit caller so service-role RPCs
  -- that already verified the user (e.g. payroll_reverse_run_atomic) do
  -- not lose identity inside the chain.
  PERFORM public.assert_can_void_je(_original.business_id, _user_id);

  IF _user_id IS NOT NULL AND _original.business_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = _user_id
        AND organization_id = _original.organization_id
        AND role IN ('super_admin','owner','admin')
    ) INTO _is_org_admin;

    IF NOT COALESCE(_is_org_admin, false) THEN
      SELECT EXISTS (
        SELECT 1 FROM public.user_business_access
        WHERE user_id = _user_id
          AND organization_id = _original.organization_id
          AND business_id = _original.business_id
      ) INTO _has_business_access;

      IF NOT COALESCE(_has_business_access, false) THEN
        RAISE EXCEPTION 'User % is not authorized to void journal entries for business % in organization %',
          _user_id, _original.business_id, _original.organization_id
          USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;

  IF _original.status = 'reversed' AND _original.reversed_by_id IS NOT NULL THEN
    RETURN _original.reversed_by_id;
  END IF;

  IF _original.status = 'voided' THEN
    RAISE EXCEPTION 'This journal entry has already been voided.';
  END IF;
  IF _original.status <> 'posted' THEN
    RAISE EXCEPTION 'Cannot void a % journal entry.', _original.status;
  END IF;
  IF _original.is_reversal = true OR _original.reversal_of_id IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot void a reversal journal entry.';
  END IF;

  _reversal_subtype := CASE
    WHEN _original.source_subtype IS NULL OR _original.source_subtype = '' THEN 'reversal'
    ELSE _original.source_subtype || '_reversal'
  END;

  _org_id      := _original.organization_id;
  _business_id := _original.business_id;
  _branch_id   := _original.branch_id;

  _final_reversal_date := COALESCE(_reversal_date, CURRENT_DATE);

  IF _entry_number IS NOT NULL AND length(btrim(_entry_number)) > 0 THEN
    _final_entry_number := _entry_number;
  ELSE
    _final_entry_number := _original.entry_number || '-REV';
  END IF;

  INSERT INTO public.journal_entries (
    id, organization_id, business_id, branch_id, entry_number,
    entry_date, description, reference,
    is_adjusting, is_closing, status,
    is_reversal, reversal_of_id, source_type, source_subtype, source_id,
    created_by, created_at, updated_at,
    posted_at, posted_by_id
  ) VALUES (
    _reversal_id, _org_id, _business_id, _branch_id, _final_entry_number,
    _final_reversal_date,
    'Reversal of ' || _original.entry_number || ': ' || _reason,
    _original.reference,
    false, false, 'posted',
    true, _original.id,
    COALESCE(_original.source_type, 'manual'),
    _reversal_subtype,
    _original.source_id,
    COALESCE(_user_id, _original.created_by), _now, _now,
    _now, COALESCE(_user_id, _original.created_by)
  );

  -- Mirror but flip debit/credit for each line.
  FOR _line IN
    SELECT * FROM public.journal_entry_lines
    WHERE journal_entry_id = _original.id
    ORDER BY sort_order NULLS LAST, id
  LOOP
    INSERT INTO public.journal_entry_lines (
      journal_entry_id, account_id, description,
      debit, credit, contact_id, sort_order, business_id, branch_id
    ) VALUES (
      _reversal_id, _line.account_id,
      'Reversal: ' || COALESCE(_line.description, ''),
      _line.credit, _line.debit, _line.contact_id, _line.sort_order,
      _business_id, _branch_id
    );
  END LOOP;

  -- Mark the original as reversed.
  UPDATE public.journal_entries
     SET status = 'reversed',
         reversed_at = _now,
         reversed_by_id = COALESCE(_user_id, created_by),
         reversed_reason = _reason,
         updated_at = _now
   WHERE id = _original.id;

  RETURN _reversal_id;
END;
$function$;

-- 4) Payroll reverse permission gate — clean separation of "operational"
--    payroll.reverse rights from governance authority.
CREATE OR REPLACE FUNCTION public.assert_can_reverse_payroll(
  _organization_id uuid,
  _caller uuid
)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := COALESCE(_caller, auth.uid());
  v_has_perm boolean := false;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Caller identity is required for payroll reversal'
      USING ERRCODE = '42501', HINT = 'IDENTITY_REQUIRED';
  END IF;

  IF public.is_governance_authority(v_uid, _organization_id) THEN
    RETURN;
  END IF;

  BEGIN
    v_has_perm := public.user_has_module_permission(
      v_uid, _organization_id, 'payroll', 'reverse'
    );
  EXCEPTION WHEN OTHERS THEN
    v_has_perm := false;
  END;

  IF NOT COALESCE(v_has_perm, false) THEN
    RAISE EXCEPTION
      'User % lacks payroll.reverse for organization %', v_uid, _organization_id
      USING ERRCODE = '42501', HINT = 'PAYROLL_REVERSE_FORBIDDEN';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.assert_can_reverse_payroll(uuid, uuid)
  TO authenticated, service_role;

-- 5) Gate payroll_reverse_run_atomic at the top so the failure mode is
--    explicit (PAYROLL_REVERSE_FORBIDDEN) rather than bubbling out of the
--    GL void path with a confusing hint.
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

  -- Authorization gate (Odoo-aligned: governance bypasses operational role).
  PERFORM public.assert_can_reverse_payroll(r.organization_id, _user_id);

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
$$;

REVOKE ALL ON FUNCTION public.payroll_reverse_run_atomic(uuid, uuid, text, boolean, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.payroll_reverse_run_atomic(uuid, uuid, text, boolean, date) TO service_role;
