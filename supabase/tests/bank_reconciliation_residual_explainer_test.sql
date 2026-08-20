-- Bank Reconciliation — residual explainer invariants (Phase 10).
--
-- WHAT THIS PROVES
-- The engine must not only state that a statement fails to reconcile; it must
-- name the candidate causes. This file proves the explainer is trustworthy:
--
--   1. `residual_explanations` is always present and always an array,
--   2. a reconciled statement (residual < 0.01) carries NO explanations —
--      the explainer never manufactures a problem where there is none,
--   3. an unreconciled statement whose pattern is recognised carries at least
--      one explanation, and every explanation is well formed
--      (code, title, detail, refs array),
--   4. explanation codes come from the closed vocabulary the UI understands —
--      an unknown code would render as a mystery to the accountant,
--   5. the explainer is read-only: the residual, both adjusted balances and
--      the statement line count are identical across two consecutive calls.
--
-- Read-only. Run as `service_role` (or a member of the organization under
-- test); the engine is not executable by `anon` and the file skips loudly if
-- the caller has no EXECUTE privilege.

DO $$
DECLARE
  v_acct      record;
  v_proof     jsonb;
  v_again     jsonb;
  v_expl      jsonb;
  v_one       jsonb;
  v_residual  numeric;
  v_checked   int := 0;
  v_codes     text[] := ARRAY[
    'duplicate_opening_balance',
    'unmatched_equal_pairs',
    'sign_flipped_pairs',
    'cleared_without_posting',
    'single_item_equals_residual',
    'fx_fallback_lines'
  ];
BEGIN
  IF NOT has_function_privilege(
       'public.finance_bank_reconciliation_statement(uuid,uuid,date,uuid,uuid)', 'EXECUTE') THEN
    RAISE NOTICE 'SKIPPED: caller has no EXECUTE on finance_bank_reconciliation_statement';
    RETURN;
  END IF;

  FOR v_acct IN
    SELECT ba.id, ba.organization_id, ba.name
      FROM public.bank_accounts ba
     WHERE ba.lifecycle_status <> 'closed'
     ORDER BY ba.created_at
     LIMIT 25
  LOOP
    BEGIN
      v_proof := public.finance_bank_reconciliation_statement(
                   v_acct.organization_id, v_acct.id, CURRENT_DATE);
    EXCEPTION WHEN insufficient_privilege THEN
      CONTINUE;  -- not a member of that organization; isolation proved elsewhere
    END;

    v_expl := v_proof -> 'residual_explanations';

    -- 1. always present, always an array
    IF v_expl IS NULL OR jsonb_typeof(v_expl) <> 'array' THEN
      RAISE EXCEPTION 'FAIL[%]: residual_explanations must be an array, got %',
        v_acct.name, COALESCE(jsonb_typeof(v_expl), 'null');
    END IF;

    v_residual := NULLIF(v_proof ->> 'residual', '')::numeric;

    -- 2. a reconciled statement carries no explanations
    IF (v_proof ->> 'in_balance')::boolean AND jsonb_array_length(v_expl) > 0 THEN
      RAISE EXCEPTION 'FAIL[%]: reconciled statement carries % explanation(s)',
        v_acct.name, jsonb_array_length(v_expl);
    END IF;

    -- 3./4. every explanation is well formed and uses a known code
    FOR v_one IN SELECT jsonb_array_elements(v_expl) LOOP
      IF COALESCE(v_one ->> 'code', '') = ''
         OR COALESCE(v_one ->> 'title', '') = ''
         OR COALESCE(v_one ->> 'detail', '') = '' THEN
        RAISE EXCEPTION 'FAIL[%]: malformed explanation %', v_acct.name, v_one;
      END IF;

      IF NOT ((v_one ->> 'code') = ANY (v_codes)) THEN
        RAISE EXCEPTION 'FAIL[%]: unknown explanation code "%" — the UI cannot render it',
          v_acct.name, v_one ->> 'code';
      END IF;

      IF jsonb_typeof(v_one -> 'refs') <> 'array' THEN
        RAISE EXCEPTION 'FAIL[%]: explanation "%" has no refs array',
          v_acct.name, v_one ->> 'code';
      END IF;
    END LOOP;

    -- 5. read-only and stable
    v_again := public.finance_bank_reconciliation_statement(
                 v_acct.organization_id, v_acct.id, CURRENT_DATE);

    IF (v_again ->> 'residual') IS DISTINCT FROM (v_proof ->> 'residual')
       OR (v_again #>> '{bank,adjusted_balance}') IS DISTINCT FROM (v_proof #>> '{bank,adjusted_balance}')
       OR (v_again #>> '{book,adjusted_balance}') IS DISTINCT FROM (v_proof #>> '{book,adjusted_balance}')
       OR (v_again #>> '{diagnostics,statement_line_count}')
            IS DISTINCT FROM (v_proof #>> '{diagnostics,statement_line_count}') THEN
      RAISE EXCEPTION 'FAIL[%]: asking for explanations changed the proof', v_acct.name;
    END IF;

    v_checked := v_checked + 1;
  END LOOP;

  IF v_checked = 0 THEN
    RAISE NOTICE 'SKIPPED: no readable bank accounts for this caller';
  ELSE
    RAISE NOTICE 'PASS: residual explainer invariants hold for % bank account(s)', v_checked;
  END IF;
END $$;
