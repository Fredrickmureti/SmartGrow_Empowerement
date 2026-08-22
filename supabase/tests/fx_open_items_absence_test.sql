-- ADR 0136 — the canonical open-item projections must not invent a rate,
-- and absence must propagate to every aggregate built on top of them.
--
-- Read-only catalogue invariants (no DML), safe to run anywhere.
--
--   1. No `finance_*` view carries a 1:1 parity fallback on an exchange rate.
--   2. No `finance_*` view carries a hardcoded currency literal.
--   3. `finance_ar_net_position_by_currency` nulls its base column when any
--      contributing document is unconvertible, and exposes the affected count.
--   4. The AR dispute / promise writers derive their currency instead of
--      assuming one, and refuse when no rate is on file.

BEGIN;

DO $$
DECLARE
  v_offenders text;
  v_def       text;
BEGIN
  -- 1. No parity fallback in the finance projections.
  SELECT string_agg(relname, ', ' ORDER BY relname) INTO v_offenders
  FROM (
    SELECT c.relname
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('v', 'm') AND c.relname LIKE 'finance\_%'
      AND pg_get_viewdef(c.oid, true) ~* 'coalesce\s*\(\s*nullif\s*\([^()]*exchange_rate[^()]*\)\s*,\s*1'
  ) s;
  IF v_offenders IS NOT NULL THEN
    RAISE EXCEPTION 'ADR 0136: these finance views fall back to a 1:1 rate: %', v_offenders;
  END IF;

  -- 2. No currency literal in the finance projections.
  SELECT string_agg(relname, ', ' ORDER BY relname) INTO v_offenders
  FROM (
    SELECT c.relname
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('v', 'm') AND c.relname LIKE 'finance\_%'
      AND pg_get_viewdef(c.oid, true) ~ '''(USD|KES|EUR|GBP)'''
  ) s;
  IF v_offenders IS NOT NULL THEN
    RAISE EXCEPTION 'ADR 0136: these finance views hardcode a currency: %', v_offenders;
  END IF;

  -- 3. Absence propagates through the per-currency aggregate.
  v_def := pg_get_viewdef('public.finance_ar_net_position_by_currency'::regclass, true);
  IF v_def !~* 'unconvertible_document_count' THEN
    RAISE EXCEPTION
      'ADR 0136: finance_ar_net_position_by_currency must report how many documents could not be converted';
  END IF;
  IF v_def !~* 'base_amt IS NULL' THEN
    RAISE EXCEPTION
      'ADR 0136: finance_ar_net_position_by_currency must null base_open_amount when a contributing item is unconvertible, not sum around it';
  END IF;

  -- 4. Collections writers derive their currency and refuse a missing rate.
  FOR v_def IN
    SELECT pg_get_functiondef(p.oid)
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname IN ('raise_ar_dispute', 'record_promise_to_pay')
  LOOP
    IF v_def ~ '''(KES|USD)''' THEN
      RAISE EXCEPTION 'ADR 0136: a collections writer hardcodes a currency: %',
        substring(v_def from 1 for 80);
    END IF;
    IF v_def !~* 'to_base_amount' OR v_def !~* 'No exchange rate on file' THEN
      RAISE EXCEPTION 'ADR 0136: a collections writer does not refuse on a missing rate: %',
        substring(v_def from 1 for 80);
    END IF;
  END LOOP;

  -- 5. Every AR/AP aggregate built on the open-item projections must guard on
  --    absence and say how many documents it could not convert.
  FOR v_def IN
    SELECT p.proname
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('get_ap_summary','get_ar_summary','get_ap_aging_summary',
                        'finance_ap_aging_reconciliation','finance_ar_aging_reconciliation',
                        'finance_ap_reconciliation_detail')
  LOOP
    IF pg_get_functiondef(('public.' || v_def)::regproc) !~* 'unconvertible' THEN
      RAISE EXCEPTION 'ADR 0136: % does not report its unconvertible document count', v_def;
    END IF;
    IF pg_get_functiondef(('public.' || v_def)::regproc) !~* 'IS NULL\) > 0' THEN
      RAISE EXCEPTION 'ADR 0136: % sums around a NULL base amount instead of nulling the total', v_def;
    END IF;
  END LOOP;

  -- 6. The base-currency aging feed reads BASE amounts for documents and for
  --    unapplied credits — never the face amount at a silent 1:1.
  v_def := pg_get_functiondef('public.get_ar_ap_aging_from_ledger'::regproc);
  IF v_def !~* 'oi\.base_residual_amount AS residual_amount' THEN
    RAISE EXCEPTION 'ADR 0136: get_ar_ap_aging_from_ledger must age the base residual';
  END IF;
  IF v_def ~* '(cc|vc)\.credit_amount AS credit_amount' THEN
    RAISE EXCEPTION 'ADR 0136: get_ar_ap_aging_from_ledger must use the BASE credit amount';
  END IF;

  -- 7. The projection/ledger drift sensor declares absence too: a tie-out that
  --    sums around an unconvertible document reports a fabricated drift.
  v_def := pg_get_viewdef('public.finance_open_items_tieout'::regclass, true);
  IF v_def !~* 'unconvertible_document_count' THEN
    RAISE EXCEPTION 'ADR 0136: finance_open_items_tieout must report its unconvertible document count';
  END IF;
  IF v_def !~* 'base_residual_amount IS NULL\) > 0' THEN
    RAISE EXCEPTION 'ADR 0136: finance_open_items_tieout must null the projection total when a document is unconvertible';
  END IF;

  RAISE NOTICE 'fx_open_items_absence_test: all contracts hold';
END $$;

ROLLBACK;
