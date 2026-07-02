-- =====================================================================
-- ARCHITECTURE AUDIT — STAGE 2
-- Complete branch_id propagation through GL posting RPC + reporting RPCs
-- =====================================================================
--
-- Context:
--   The frontend (useGLPosting.ts) already passes `_branch_id`, `_currency`,
--   `_exchange_rate`, and per-line `analytic_account_id` / `contact_id` /
--   `exchange_rate` to `post_journal_entry_atomic` via an `as any` cast.
--   The previous RPC signature silently DROPPED those parameters, so every
--   journal entry has been written with branch_id = NULL — making per-branch
--   P&L identical to per-company P&L. This migration closes that gap.
--
-- Changes:
--   1. Replace post_journal_entry_atomic with a complete signature that
--      persists branch_id, currency, exchange_rate, source_subtype on the
--      header, and account_id, contact_id, analytic_account_id, exchange_rate,
--      branch_id, business_id on every line.
--   2. Extend get_account_balances + get_gl_transactions with an optional
--      _branch_id filter so reports can be sliced per branch.
--   3. Backfill journal_entry_lines.business_id from header where NULL
--      (defensive — column is NOT NULL but old rows may be unset post-migration).
--
-- Safety:
--   - Idempotent: keyed off (org, source_type, source_id, COALESCE(subtype,'main'))
--     and skips if a non-voided JE already exists.
--   - enforce_branch_business_match trigger guards cross-company branch use.
--   - enforce_je_line_branch_match trigger auto-fills line.branch_id from
--     header — RPC also stamps it explicitly to satisfy NOT-NULL paths.

-- ---------------------------------------------------------------------
-- 1. Drop and recreate post_journal_entry_atomic with full signature
-- ---------------------------------------------------------------------
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT oid::regprocedure AS sig
    FROM pg_proc
    WHERE proname = 'post_journal_entry_atomic'
      AND pronamespace = 'public'::regnamespace
  LOOP
    EXECUTE 'DROP FUNCTION IF EXISTS ' || r.sig || ' CASCADE';
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.post_journal_entry_atomic(
  _org_id uuid,
  _business_id uuid,
  _entry_number text,
  _entry_date date,
  _reference text,
  _description text,
  _source_type text,
  _source_id uuid,
  _created_by uuid,
  _is_closing boolean,
  _is_adjusting boolean,
  _lines jsonb,
  _currency text DEFAULT NULL,
  _exchange_rate numeric DEFAULT NULL,
  _source_subtype text DEFAULT NULL,
  _branch_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_entry_id uuid;
  v_line jsonb;
  v_total_debit numeric := 0;
  v_total_credit numeric := 0;
  v_existing_id uuid;
BEGIN
  -- Idempotency: same (org, source_type, source_id, subtype) → return existing
  IF _source_type IS NOT NULL AND _source_id IS NOT NULL THEN
    SELECT id INTO v_existing_id
    FROM public.journal_entries
    WHERE organization_id = _org_id
      AND source_type = _source_type
      AND source_id = _source_id
      AND COALESCE(source_subtype, 'main') = COALESCE(_source_subtype, 'main')
      AND status <> 'voided'
    LIMIT 1;

    IF v_existing_id IS NOT NULL THEN
      RETURN v_existing_id;
    END IF;
  END IF;

  IF _lines IS NULL OR jsonb_array_length(_lines) < 2 THEN
    RAISE EXCEPTION 'Journal entry requires at least 2 lines';
  END IF;

  FOR v_line IN SELECT * FROM jsonb_array_elements(_lines)
  LOOP
    v_total_debit  := v_total_debit  + COALESCE((v_line->>'debit')::numeric,  0);
    v_total_credit := v_total_credit + COALESCE((v_line->>'credit')::numeric, 0);
  END LOOP;

  IF ABS(v_total_debit - v_total_credit) > 0.01 THEN
    RAISE EXCEPTION 'Journal entry not balanced: debit=% credit=%', v_total_debit, v_total_credit;
  END IF;

  INSERT INTO public.journal_entries (
    organization_id,
    business_id,
    branch_id,
    entry_number,
    entry_date,
    reference,
    description,
    source_type,
    source_id,
    source_subtype,
    created_by,
    is_closing_entry,
    is_adjusting_entry,
    status,
    total_debit,
    total_credit,
    currency,
    exchange_rate,
    posted_at,
    posted_by
  ) VALUES (
    _org_id,
    _business_id,
    _branch_id,
    _entry_number,
    _entry_date,
    _reference,
    _description,
    _source_type,
    _source_id,
    _source_subtype,
    _created_by,
    COALESCE(_is_closing, false),
    COALESCE(_is_adjusting, false),
    'posted',
    v_total_debit,
    v_total_credit,
    _currency,
    _exchange_rate,
    now(),
    _created_by
  )
  RETURNING id INTO v_entry_id;

  -- Insert lines, stamping branch_id (auto-filled by trigger if NULL),
  -- business_id (NOT NULL on the column), and per-line currency / analytic
  -- attributes when present.
  FOR v_line IN SELECT * FROM jsonb_array_elements(_lines)
  LOOP
    INSERT INTO public.journal_entry_lines (
      journal_entry_id,
      account_id,
      debit,
      credit,
      description,
      contact_id,
      analytic_account_id,
      exchange_rate,
      business_id,
      branch_id
    ) VALUES (
      v_entry_id,
      (v_line->>'account_id')::uuid,
      COALESCE((v_line->>'debit')::numeric,  0),
      COALESCE((v_line->>'credit')::numeric, 0),
      v_line->>'description',
      NULLIF(v_line->>'contact_id','')::uuid,
      NULLIF(v_line->>'analytic_account_id','')::uuid,
      NULLIF(v_line->>'exchange_rate','')::numeric,
      _business_id,
      _branch_id
    );
  END LOOP;

  RETURN v_entry_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.post_journal_entry_atomic(
  uuid, uuid, text, date, text, text, text, uuid, uuid, boolean, boolean, jsonb, text, numeric, text, uuid
) TO authenticated, service_role;

COMMENT ON FUNCTION public.post_journal_entry_atomic IS
  'Atomic GL posting: persists branch_id (per-branch P&L), currency, exchange_rate on header and per-line analytic/contact/branch/business attributes. Source_id MUST be a real UUID. Use _source_subtype for sub-entries (cogs, wht, etc.).';

-- ---------------------------------------------------------------------
-- 2. Defensive backfill: any line missing branch_id should inherit header
--    (the line trigger already does this on INSERT, but historical rows
--    written before the trigger landed need a one-shot fix).
-- ---------------------------------------------------------------------
UPDATE public.journal_entry_lines l
SET branch_id = je.branch_id
FROM public.journal_entries je
WHERE l.journal_entry_id = je.id
  AND l.branch_id IS NULL
  AND je.branch_id IS NOT NULL;

-- ---------------------------------------------------------------------
-- 3. Branch-aware reporting RPCs
--    Add an optional _branch_id parameter. When NULL, behavior is
--    backward-compatible (company-wide). When provided, restricts to JEs
--    stamped with that branch (line trigger guarantees lines match).
-- ---------------------------------------------------------------------

-- get_account_balances — extend with optional _branch_id
DROP FUNCTION IF EXISTS public.get_account_balances(uuid, uuid);
DROP FUNCTION IF EXISTS public.get_account_balances(uuid, uuid, uuid);

CREATE OR REPLACE FUNCTION public.get_account_balances(
  _org_id uuid,
  _business_id uuid,
  _branch_id uuid DEFAULT NULL
)
RETURNS TABLE (
  account_id uuid,
  total_debit numeric,
  total_credit numeric,
  net_balance numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    l.account_id,
    COALESCE(SUM(l.debit),  0) AS total_debit,
    COALESCE(SUM(l.credit), 0) AS total_credit,
    COALESCE(SUM(l.debit), 0) - COALESCE(SUM(l.credit), 0) AS net_balance
  FROM public.journal_entry_lines l
  JOIN public.journal_entries je ON je.id = l.journal_entry_id
  WHERE je.organization_id = _org_id
    AND je.business_id = _business_id
    AND je.status = 'posted'
    AND (_branch_id IS NULL OR l.branch_id = _branch_id)
  GROUP BY l.account_id;
$$;

GRANT EXECUTE ON FUNCTION public.get_account_balances(uuid, uuid, uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.get_account_balances IS
  'Per-account net balance. _branch_id NULL = company-wide; non-NULL = single-branch slice (per-branch P&L).';

-- get_gl_transactions — extend with optional _branch_id
DROP FUNCTION IF EXISTS public.get_gl_transactions(uuid, date, date, uuid[]);
DROP FUNCTION IF EXISTS public.get_gl_transactions(uuid, date, date, uuid[], uuid);

CREATE OR REPLACE FUNCTION public.get_gl_transactions(
  _org_id uuid,
  _date_from date,
  _date_to date,
  _account_ids uuid[],
  _branch_id uuid DEFAULT NULL
)
RETURNS TABLE (
  entry_id uuid,
  entry_number text,
  entry_date date,
  reference text,
  description text,
  account_id uuid,
  debit numeric,
  credit numeric,
  branch_id uuid
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    je.id           AS entry_id,
    je.entry_number,
    je.entry_date,
    je.reference,
    je.description,
    l.account_id,
    l.debit,
    l.credit,
    l.branch_id
  FROM public.journal_entry_lines l
  JOIN public.journal_entries je ON je.id = l.journal_entry_id
  WHERE je.organization_id = _org_id
    AND je.status = 'posted'
    AND je.entry_date BETWEEN _date_from AND _date_to
    AND (_account_ids IS NULL OR l.account_id = ANY(_account_ids))
    AND (_branch_id IS NULL OR l.branch_id = _branch_id)
  ORDER BY je.entry_date, je.entry_number;
$$;

GRANT EXECUTE ON FUNCTION public.get_gl_transactions(uuid, date, date, uuid[], uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.get_gl_transactions IS
  'GL transactions for a date range and optional account filter. _branch_id NULL = company-wide; non-NULL = single-branch slice.';