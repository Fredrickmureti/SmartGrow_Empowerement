-- Phase 2: Make void_journal_entry_atomic business/branch/analytic-aware.
-- Root cause of the user's "journal_entry_lines.business_id (<NULL>) must match ..."
-- error: the previous reversal-line INSERT did not copy business_id, branch_id,
-- analytic_account_id, exchange_rate, or tax_rate_id from the original line,
-- so the enforce_je_line_company_match / enforce_je_line_branch_match triggers
-- correctly rejected the insert.
--
-- This migration replaces ONLY the reversal-line INSERT to mirror every scope
-- column from the original line. Header logic, idempotency, authorization, and
-- subtype-aware reversal handling are preserved verbatim from the deployed fn.

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

  -- Insert reversal header WITH branch_id + currency + exchange_rate so that
  -- branch-aware reports and FX consolidation reflect the reversal correctly.
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

  -- Mirror lines with FULL scope: business_id, branch_id, analytic, contact,
  -- exchange_rate. The branch trigger auto-fills branch_id from header when
  -- NULL, but we stamp it explicitly to satisfy the company-match trigger and
  -- to keep historical analytic dimensions intact.
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

COMMENT ON FUNCTION public.void_journal_entry_atomic IS
  'Atomic, idempotent reversal. Reversal lines now mirror business_id, branch_id, contact_id, analytic_account_id, exchange_rate, tax_rate_id, sort_order from the original — fixes "journal_entry_lines.business_id (<NULL>) must match ..." trigger error.';