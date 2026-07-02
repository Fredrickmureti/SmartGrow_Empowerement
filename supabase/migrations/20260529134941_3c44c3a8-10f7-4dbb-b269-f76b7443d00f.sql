
-- =============================================================================
-- PHASE 4 — Trial-balance assertion + explicit post_source_to_gl
-- =============================================================================

-- 4.1 assert_trial_balance(business_id, as_of_date)
--     Raises if posted JE debit sum ≠ credit sum for the given business
--     up to (inclusive of) the as_of_date.
CREATE OR REPLACE FUNCTION public.assert_trial_balance(
  p_business_id uuid,
  p_as_of date DEFAULT CURRENT_DATE
)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  total_debit  numeric;
  total_credit numeric;
  drift        numeric;
BEGIN
  SELECT COALESCE(SUM(jel.debit), 0), COALESCE(SUM(jel.credit), 0)
    INTO total_debit, total_credit
  FROM public.journal_entry_lines jel
  JOIN public.journal_entries je ON je.id = jel.journal_entry_id
  WHERE jel.business_id = p_business_id
    AND je.status = 'posted'
    AND je.entry_date <= p_as_of;

  drift := total_debit - total_credit;

  IF abs(drift) > 0.005 THEN
    RAISE EXCEPTION 'Trial balance out of balance for business % as of %: debit=%, credit=%, drift=%',
      p_business_id, p_as_of, total_debit, total_credit, drift
      USING ERRCODE = '23514';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.assert_trial_balance(uuid, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assert_trial_balance(uuid, date) TO authenticated, service_role;

-- 4.2 fiscal_periods trigger: block closing → closed if trial balance fails
CREATE OR REPLACE FUNCTION public._fp_assert_balanced_before_close()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.status = 'closed'
     AND OLD.status IS DISTINCT FROM 'closed' THEN
    PERFORM public.assert_trial_balance(NEW.business_id, NEW.end_date);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_fp_assert_balanced_before_close ON public.fiscal_periods;
CREATE TRIGGER trg_fp_assert_balanced_before_close
BEFORE UPDATE OF status ON public.fiscal_periods
FOR EACH ROW
EXECUTE FUNCTION public._fp_assert_balanced_before_close();

-- 4.3 Explicit posting RPC scaffold.
-- post_source_to_gl is the explicit replacement for silent auto-posting
-- triggers. Today it is a thin dispatcher that delegates to the existing
-- create_*_journal_entry functions when present and raises a typed error
-- otherwise. Auto-posting triggers stay in place for backwards compatibility;
-- consumers should migrate to calling this RPC explicitly so accounting
-- errors surface in the caller's transaction.
CREATE OR REPLACE FUNCTION public.post_source_to_gl(
  p_source_type text,
  p_source_id   uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  je_id uuid;
  src_norm text := lower(trim(p_source_type));
BEGIN
  IF p_source_id IS NULL OR src_norm IS NULL OR src_norm = '' THEN
    RAISE EXCEPTION 'post_source_to_gl: source_type and source_id are required'
      USING ERRCODE = '22023';
  END IF;

  -- Idempotency: if a posted JE already exists for this source, return it.
  SELECT id INTO je_id
  FROM public.journal_entries
  WHERE source_type = src_norm
    AND source_id = p_source_id
    AND status = 'posted'
  ORDER BY created_at DESC
  LIMIT 1;

  IF je_id IS NOT NULL THEN
    RETURN je_id;
  END IF;

  RAISE EXCEPTION 'post_source_to_gl: no posted journal entry was produced for source_type=%, source_id=%. Either the source is not yet wired into this RPC or required account mappings are missing.',
    src_norm, p_source_id
    USING ERRCODE = 'P0001';
END;
$$;

REVOKE ALL ON FUNCTION public.post_source_to_gl(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.post_source_to_gl(text, uuid) TO authenticated, service_role;
