-- Phase 0 of the business reversal convergence plan.
--
-- Root cause: public.void_journal_entry_atomic mirrors each line of the entry
-- being reversed but omitted organization_id from the INSERT. The column is
-- NOT NULL and trg_jel_enforce_org_match validates (rather than backfills) it,
-- so every journal reversal in the platform failed with
--   journal_entry_lines.organization_id (<NULL>) must match parent ...
--
-- This is the terminal writer for invoice void (revenue + COGS legs), payment
-- void, bill/bill-payment void, manual journal void and payroll run reversal.

-- 1. Stamp organization_id on the reversal lines (parity with
--    post_journal_entry_atomic, which already stamps all three scope columns).
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
  _reversal_subtype text;
  _is_org_admin boolean;
  _has_business_access boolean;
BEGIN
  SELECT * INTO _original FROM journal_entries WHERE id = _entry_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Journal entry not found: %', _entry_id;
  END IF;

  -- Phase 7 gate — accepts an explicit caller so service-role RPCs that
  -- already verified the user (e.g. payroll_reverse_run_atomic) do not lose
  -- identity inside the chain.
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

  -- Mirror but flip debit/credit for each line. organization_id MUST be
  -- stamped here: journal_entry_lines.organization_id is NOT NULL and
  -- trg_jel_enforce_org_match requires it to equal the parent entry's.
  FOR _line IN
    SELECT * FROM public.journal_entry_lines
    WHERE journal_entry_id = _original.id
    ORDER BY sort_order NULLS LAST, id
  LOOP
    INSERT INTO public.journal_entry_lines (
      journal_entry_id, account_id, description,
      debit, credit, contact_id, sort_order,
      organization_id, business_id, branch_id
    ) VALUES (
      _reversal_id, _line.account_id,
      'Reversal: ' || COALESCE(_line.description, ''),
      _line.credit, _line.debit, _line.contact_id, _line.sort_order,
      _org_id, _business_id, _branch_id
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

-- 2. Harden the class, not the instance. The canonical BEFORE INSERT context
--    defaulter (trg_default_je_line_context, which runs before
--    trg_jel_enforce_org_match by name order) already backfills business_id
--    and branch_id from the parent entry; extend it to organization_id so no
--    future line writer can reintroduce this failure mode.
CREATE OR REPLACE FUNCTION public.default_je_line_context_from_parent()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  parent_org      uuid;
  parent_business uuid;
  parent_branch   uuid;
BEGIN
  IF NEW.organization_id IS NOT NULL
     AND NEW.business_id IS NOT NULL
     AND NEW.branch_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT organization_id, business_id, branch_id
    INTO parent_org, parent_business, parent_branch
    FROM public.journal_entries
   WHERE id = NEW.journal_entry_id;

  IF parent_org IS NULL THEN
    -- Let the existing strict match trigger raise the canonical error.
    RETURN NEW;
  END IF;

  IF NEW.organization_id IS NULL THEN
    NEW.organization_id := parent_org;
  END IF;

  IF NEW.business_id IS NULL THEN
    NEW.business_id := parent_business;
  END IF;

  -- Only default branch_id from the parent if the line has none. We never
  -- override an explicit branch_id; the strict match trigger will reject
  -- any cross-branch attempt.
  IF NEW.branch_id IS NULL AND parent_branch IS NOT NULL THEN
    NEW.branch_id := parent_branch;
  END IF;

  RETURN NEW;
END;
$function$;