-- ============================================================================
-- Phase 7 — Journal Entries permission gating
-- ============================================================================

-- 1. Helper: assert_can_manage_je --------------------------------------------
CREATE OR REPLACE FUNCTION public.assert_can_manage_je(_business_id uuid)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _uid uuid := auth.uid();
  _is_admin boolean := false;
  _has_perm boolean := false;
BEGIN
  IF _uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  IF _business_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM public.user_roles ur
      JOIN public.businesses b ON b.organization_id = ur.organization_id
      WHERE ur.user_id = _uid
        AND b.id = _business_id
        AND ur.role IN ('super_admin','owner','admin')
    ) INTO _is_admin;
    IF _is_admin THEN RETURN; END IF;
  END IF;

  SELECT public.has_finance_permission(_uid, 'finance.manage_je', _business_id) INTO _has_perm;
  IF NOT COALESCE(_has_perm, false) THEN
    RAISE EXCEPTION 'INSUFFICIENT_PRIVILEGE_JE_MANAGE: user % lacks finance.manage_je for business %', _uid, _business_id
      USING ERRCODE = '42501';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.assert_can_manage_je(uuid) TO authenticated;

-- 2. Helper: assert_can_void_je ----------------------------------------------
CREATE OR REPLACE FUNCTION public.assert_can_void_je(_business_id uuid)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _uid uuid := auth.uid();
  _is_admin boolean := false;
  _has_perm boolean := false;
BEGIN
  IF _uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  IF _business_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM public.user_roles ur
      JOIN public.businesses b ON b.organization_id = ur.organization_id
      WHERE ur.user_id = _uid
        AND b.id = _business_id
        AND ur.role IN ('super_admin','owner','admin')
    ) INTO _is_admin;
    IF _is_admin THEN RETURN; END IF;
  END IF;

  SELECT public.has_finance_permission(_uid, 'finance.void_je', _business_id) INTO _has_perm;
  IF NOT COALESCE(_has_perm, false) THEN
    RAISE EXCEPTION 'INSUFFICIENT_PRIVILEGE_JE_VOID: user % lacks finance.void_je for business %', _uid, _business_id
      USING ERRCODE = '42501';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.assert_can_void_je(uuid) TO authenticated;

-- 3. Re-define create_journal_entry_atomic with permission gate at the top ---
CREATE OR REPLACE FUNCTION public.create_journal_entry_atomic(
  _org_id uuid,
  _business_id uuid,
  _entry_number text,
  _entry_date date,
  _description text,
  _reference text,
  _is_adjusting boolean,
  _is_closing boolean,
  _created_by uuid,
  _lines jsonb,
  _branch_id uuid DEFAULT NULL::uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _entry_id uuid;
  _line jsonb;
  _total_debit numeric := 0;
  _total_credit numeric := 0;
  _sort integer := 0;
BEGIN
  -- Phase 7 gate: manual JE creation requires finance.manage_je at company scope.
  PERFORM public.assert_can_manage_je(_business_id);

  FOR _line IN SELECT * FROM jsonb_array_elements(_lines) LOOP
    _total_debit  := _total_debit  + COALESCE((_line->>'debit')::numeric, 0);
    _total_credit := _total_credit + COALESCE((_line->>'credit')::numeric, 0);
  END LOOP;

  IF ABS(_total_debit - _total_credit) > 0.01 THEN
    RAISE EXCEPTION 'Journal entry is not balanced: debits (%) != credits (%)', _total_debit, _total_credit;
  END IF;

  INSERT INTO journal_entries (
    organization_id, business_id, branch_id, entry_number, entry_date,
    description, reference, is_adjusting, is_closing,
    status, created_by
  ) VALUES (
    _org_id, _business_id, _branch_id, _entry_number, _entry_date,
    _description, _reference, _is_adjusting, _is_closing,
    'posted', _created_by
  )
  RETURNING id INTO _entry_id;

  FOR _line IN SELECT * FROM jsonb_array_elements(_lines) LOOP
    INSERT INTO journal_entry_lines (
      journal_entry_id, account_id, description,
      debit, credit, contact_id, sort_order,
      business_id, branch_id
    ) VALUES (
      _entry_id,
      (_line->>'account_id')::uuid,
      _line->>'description',
      COALESCE((_line->>'debit')::numeric, 0),
      COALESCE((_line->>'credit')::numeric, 0),
      CASE WHEN _line->>'contact_id' IS NOT NULL THEN (_line->>'contact_id')::uuid ELSE NULL END,
      _sort,
      _business_id,
      _branch_id
    );
    _sort := _sort + 1;
  END LOOP;

  RETURN _entry_id;
END;
$$;

-- 4. Re-define void_journal_entry_atomic with permission gate at the top -----
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
BEGIN
  SELECT * INTO _original FROM journal_entries WHERE id = _entry_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Journal entry not found: %', _entry_id;
  END IF;

  -- Phase 7 gate: voiding/reversing requires finance.void_je at the journal's
  -- company scope. Still allows the legacy admin/owner override below to
  -- continue working because assert_can_void_je short-circuits for org admins.
  PERFORM public.assert_can_void_je(_original.business_id);

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
    ELSE 'reversal:' || _original.source_subtype
  END;

  IF _original.source_type IS NOT NULL AND _original.source_id IS NOT NULL THEN
    SELECT id INTO _existing_reversal
    FROM journal_entries
    WHERE organization_id = _original.organization_id
      AND source_type = _original.source_type
      AND source_id = _original.source_id
      AND source_subtype = _reversal_subtype
      AND status <> 'voided'
    LIMIT 1;
    IF _existing_reversal IS NOT NULL THEN
      UPDATE journal_entries
      SET status = 'reversed', reversed_by_id = _existing_reversal, updated_at = _now
      WHERE id = _entry_id AND status = 'posted';
      RETURN _existing_reversal;
    END IF;
  END IF;

  _org_id := _original.organization_id;
  _business_id := _original.business_id;
  _branch_id := _original.branch_id;
  _final_reversal_date := COALESCE(_reversal_date, CURRENT_DATE);

  IF _entry_number IS NULL THEN
    SELECT COALESCE(
      'JE-' || LPAD((COALESCE(MAX(NULLIF(regexp_replace(entry_number, '[^0-9]', '', 'g'), ''))::int, 0) + 1)::text, 5, '0'),
      'JE-00001'
    ) INTO _final_entry_number
    FROM journal_entries WHERE organization_id = _org_id;
  ELSE
    _final_entry_number := _entry_number;
  END IF;

  INSERT INTO journal_entries (
    id, organization_id, business_id, branch_id,
    entry_number, entry_date,
    description, reference, status, posted_at, posted_by, created_by,
    source_type, source_id, source_subtype,
    is_reversal, is_reversing, reversal_of_id,
    void_reason, currency, exchange_rate,
    created_at, updated_at
  ) VALUES (
    _reversal_id, _org_id, _business_id, _branch_id,
    _final_entry_number, _final_reversal_date,
    'Reversal of ' || _original.entry_number || ': ' || _reason,
    _original.reference,
    'posted', _now, _user_id, _user_id,
    COALESCE(_original.source_type, 'void'),
    COALESCE(_original.source_id, _entry_id),
    _reversal_subtype,
    true, true, _entry_id,
    _reason, _original.currency, _original.exchange_rate,
    _now, _now
  );

  FOR _line IN
    SELECT * FROM journal_entry_lines WHERE journal_entry_id = _entry_id ORDER BY sort_order
  LOOP
    INSERT INTO journal_entry_lines (
      journal_entry_id, account_id, description,
      debit, credit,
      contact_id, analytic_account_id, exchange_rate,
      business_id, branch_id, tax_rate_id,
      sort_order, created_at
    ) VALUES (
      _reversal_id, _line.account_id,
      'REVERSAL: ' || COALESCE(_line.description, ''),
      COALESCE(_line.credit, 0),
      COALESCE(_line.debit, 0),
      _line.contact_id, _line.analytic_account_id, _line.exchange_rate,
      _business_id, _branch_id, _line.tax_rate_id,
      _line.sort_order, _now
    );
  END LOOP;

  UPDATE journal_entries
  SET status = 'reversed',
      reversed_by_id = _reversal_id,
      voided_at = _now,
      voided_by = _user_id,
      void_reason = _reason,
      updated_at = _now
  WHERE id = _entry_id;

  RETURN _reversal_id;
END;
$function$;

COMMENT ON FUNCTION public.assert_can_manage_je(uuid) IS
  'Phase 7: gate manual journal-entry creation/edit. Raises INSUFFICIENT_PRIVILEGE_JE_MANAGE.';
COMMENT ON FUNCTION public.assert_can_void_je(uuid) IS
  'Phase 7: gate journal-entry void/reverse. Raises INSUFFICIENT_PRIVILEGE_JE_VOID.';