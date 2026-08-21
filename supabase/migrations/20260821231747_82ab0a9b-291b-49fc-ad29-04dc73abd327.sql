-- Phase 11 — FX isolation ratchet (ADR 0136 / 0138).
--
-- Two holes closed:
--   1. resolve_exchange_rate / require_exchange_rate / resolve_sales_exchange_rate /
--      fx_stamp_document are SECURITY DEFINER and were granted to `authenticated`.
--      They take an arbitrary (org, business) pair and perform no membership check,
--      so any signed-in user could read another tenant's rate book through the
--      Data API. They are engine internals — every legitimate caller is another
--      SECURITY DEFINER function that executes as the owner and therefore keeps
--      its EXECUTE right after the revoke. The tenant-facing surface stays
--      `describe_exchange_rate`, which already enforces user_can_access_business.
--   2. reverse_fx_revaluation_run posts a reversing journal and was reachable from
--      the Data API with nothing but a run id — no membership, no permission. Its
--      only in-database caller is revalue_fx_balances, which is already gated on
--      finance.manage_periods for the target business.

REVOKE EXECUTE ON FUNCTION public.resolve_exchange_rate(uuid, uuid, text, date) FROM authenticated, anon;
REVOKE EXECUTE ON FUNCTION public.require_exchange_rate(uuid, uuid, text, date) FROM authenticated, anon;
REVOKE EXECUTE ON FUNCTION public.resolve_sales_exchange_rate(uuid, uuid, text, date) FROM authenticated, anon;
REVOKE EXECUTE ON FUNCTION public.fx_stamp_document(uuid, uuid, text, date) FROM authenticated, anon;
REVOKE EXECUTE ON FUNCTION public.reverse_fx_revaluation_run(uuid, date, uuid, uuid) FROM authenticated, anon;

-- Defense in depth: even reached as the owner, a reversal must be authorised
-- against the business that owns the run — never against the caller's argument.
CREATE OR REPLACE FUNCTION public.reverse_fx_revaluation_run(_run_id uuid, _reversal_date date, _user_id uuid DEFAULT NULL::uuid, _next_run_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _run public.fx_revaluation_runs;
  _lines jsonb := '[]'::jsonb;
  _l record;
  _je_id uuid;
  _uid uuid := COALESCE(auth.uid(), _user_id);
BEGIN
  SELECT * INTO _run FROM public.fx_revaluation_runs WHERE id = _run_id;
  IF _run.id IS NULL THEN
    RAISE EXCEPTION 'FX revaluation run % not found', _run_id USING ERRCODE = 'P0002';
  END IF;

  -- Authorisation is derived from the run's own business, not from any argument.
  IF auth.uid() IS NOT NULL
     AND NOT public.has_finance_permission(_uid, 'finance.manage_periods', _run.business_id) THEN
    RAISE EXCEPTION 'You do not have permission to reverse FX revaluation for this business'
      USING ERRCODE = '42501';
  END IF;

  IF _run.status <> 'posted' THEN
    RAISE EXCEPTION 'Only a posted FX revaluation run can be reversed' USING ERRCODE = '23514';
  END IF;
  IF _run.reversal_journal_entry_id IS NOT NULL THEN
    RETURN _run.reversal_journal_entry_id;
  END IF;

  IF _run.journal_entry_id IS NULL THEN
    UPDATE public.fx_revaluation_runs
       SET status = 'reversed', reversed_at = now(), reversed_by_run_id = _next_run_id
     WHERE id = _run_id;
    RETURN NULL;
  END IF;

  FOR _l IN
    SELECT account_id, business_id, branch_id, description, debit, credit
      FROM public.journal_entry_lines
     WHERE journal_entry_id = _run.journal_entry_id
     ORDER BY id
  LOOP
    _lines := _lines || jsonb_build_object(
      'account_id', _l.account_id,
      'business_id', _l.business_id,
      'branch_id', _l.branch_id,
      'description', 'Reversal — ' || COALESCE(_l.description, 'FX revaluation'),
      'debit', COALESCE(_l.credit, 0),
      'credit', COALESCE(_l.debit, 0)
    );
  END LOOP;

  IF jsonb_array_length(_lines) = 0 THEN
    RAISE EXCEPTION 'FX revaluation journal entry % has no lines to reverse', _run.journal_entry_id
      USING ERRCODE = '23514';
  END IF;

  -- ADR-0146: the posting engine is the only journal numberer.
  _je_id := public.post_journal_entry_atomic(
    _run.organization_id, _run.business_id, NULL, _reversal_date,
    NULL,
    'Reversal of unrealized FX revaluation dated ' || _run.run_date,
    'fx_revaluation_reversal', _run.id, _user_id, false, true,
    _lines, _run.base_currency, 1, NULL, NULL
  );

  UPDATE public.journal_entries
     SET journal_book_id = COALESCE(journal_book_id, _run.journal_book_id)
   WHERE id = _je_id;

  UPDATE public.fx_revaluation_runs
     SET status = 'reversed',
         reversal_journal_entry_id = _je_id,
         reversed_at = now(),
         reversed_by_run_id = _next_run_id
   WHERE id = _run_id;

  RETURN _je_id;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.reverse_fx_revaluation_run(uuid, date, uuid, uuid) FROM authenticated, anon;
GRANT EXECUTE ON FUNCTION public.reverse_fx_revaluation_run(uuid, date, uuid, uuid) TO service_role;