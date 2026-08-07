-- Phase 0 of the business reversal convergence plan — regression coverage for
-- the shared journal reversal writer `void_journal_entry_atomic`.
--
-- Background: the reversal-line INSERT omitted `organization_id`. Because
-- `journal_entry_lines.organization_id` is NOT NULL and
-- `trg_jel_enforce_org_match` validates (rather than backfills) it, EVERY
-- reversal in the platform failed — invoice void (revenue + COGS legs),
-- payment void, bill/bill-payment void, manual journal void and payroll run
-- reversal all funnel through this one function. Nothing detected it because
-- no test exercised a reversal end to end.
--
-- Behavioural blocks run inside a DO block that force-rolls back, so this file
-- is safe against any environment.

-- 1) Contract: exactly one reversal writer — no parallel implementations.
DO $$
DECLARE v_count int;
BEGIN
  SELECT count(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'void_journal_entry_atomic';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'void_journal_entry_atomic must have exactly one overload, found %', v_count;
  END IF;
END $$;

-- 2) Contract: the posting monopoly (ADR 0123) — only the three engine
--    functions may insert journal lines. A new writer here is the exact class
--    of drift that produced this outage.
DO $$
DECLARE v_rogue text;
BEGIN
  SELECT string_agg(p.proname, ', ') INTO v_rogue
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.prosrc ~* 'insert\s+into\s+(public\.)?journal_entry_lines'
     AND p.proname NOT IN (
       'post_journal_entry_atomic',
       'update_journal_entry_atomic',
       'void_journal_entry_atomic'
     );
  IF v_rogue IS NOT NULL THEN
    RAISE EXCEPTION 'journal line writers outside the posting engine: % (ADR 0123)', v_rogue;
  END IF;
END $$;

-- 3) Contract: the reversal writer stamps every scope column on its mirrored
--    lines, and never deletes history.
DO $$
DECLARE v_src text;
BEGIN
  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'void_journal_entry_atomic';

  IF v_src !~* 'insert\s+into\s+public\.journal_entry_lines[^;]*organization_id' THEN
    RAISE EXCEPTION
      'void_journal_entry_atomic does not stamp organization_id on reversal lines — every reversal in the platform will fail the NOT NULL / parent-match guard';
  END IF;
  IF v_src !~* 'insert\s+into\s+public\.journal_entry_lines[^;]*business_id' THEN
    RAISE EXCEPTION 'void_journal_entry_atomic does not stamp business_id on reversal lines';
  END IF;
  IF v_src ~* 'delete\s+from\s+(public\.)?journal_entr' THEN
    RAISE EXCEPTION 'void_journal_entry_atomic deletes journal rows — reversal must preserve history';
  END IF;
END $$;

-- 4) Contract: the shared context defaulter backfills organization_id from the
--    parent entry, so this failure class cannot return through another writer.
DO $$
DECLARE v_src text;
BEGIN
  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'default_je_line_context_from_parent';
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'default_je_line_context_from_parent is missing';
  END IF;
  IF v_src !~* 'NEW\.organization_id\s*:=' THEN
    RAISE EXCEPTION 'default_je_line_context_from_parent no longer backfills organization_id';
  END IF;
END $$;

-- 5) Behavioural: a multi-line posted entry reverses, and every reversal line
--    carries the parent entry's organization_id / business_id.
DO $$
DECLARE
  v_org uuid; v_biz uuid;
  v_entry uuid; v_reversal uuid;
  v_bad int; v_lines int; v_rev_lines int;
  v_debit numeric; v_credit numeric;
  v_status text;
BEGIN
  SELECT je.id, je.organization_id, je.business_id
    INTO v_entry, v_org, v_biz
    FROM public.journal_entries je
   WHERE je.status = 'posted'
     AND COALESCE(je.is_reversal, false) = false
     AND je.reversal_of_id IS NULL
     AND je.organization_id IS NOT NULL
     AND (SELECT count(*) FROM public.journal_entry_lines l
           WHERE l.journal_entry_id = je.id) >= 2
   ORDER BY je.created_at DESC
   LIMIT 1;

  IF v_entry IS NULL THEN
    RAISE NOTICE 'no eligible posted multi-line journal entry — behavioural block skipped';
    RETURN;
  END IF;

  SELECT count(*) INTO v_lines
    FROM public.journal_entry_lines WHERE journal_entry_id = v_entry;

  v_reversal := public.void_journal_entry_atomic(v_entry, 'phase-0 regression test', NULL, NULL, CURRENT_DATE);

  IF v_reversal IS NULL THEN
    RAISE EXCEPTION 'void_journal_entry_atomic returned NULL';
  END IF;

  -- Every mirrored line is scoped to the same organization and business.
  SELECT count(*) INTO v_bad
    FROM public.journal_entry_lines l
   WHERE l.journal_entry_id = v_reversal
     AND (l.organization_id IS DISTINCT FROM v_org
       OR l.business_id     IS DISTINCT FROM v_biz);
  IF v_bad > 0 THEN
    RAISE EXCEPTION '% reversal lines have the wrong organization/business scope', v_bad;
  END IF;

  -- All lines were mirrored, none dropped.
  SELECT count(*) INTO v_rev_lines
    FROM public.journal_entry_lines WHERE journal_entry_id = v_reversal;
  IF v_rev_lines <> v_lines THEN
    RAISE EXCEPTION 'reversal mirrored % of % lines', v_rev_lines, v_lines;
  END IF;

  -- The reversal is balanced (debits and credits are swapped, totals equal).
  SELECT COALESCE(SUM(debit), 0), COALESCE(SUM(credit), 0)
    INTO v_debit, v_credit
    FROM public.journal_entry_lines WHERE journal_entry_id = v_reversal;
  IF v_debit IS DISTINCT FROM v_credit THEN
    RAISE EXCEPTION 'reversal entry is unbalanced: debit % credit %', v_debit, v_credit;
  END IF;

  -- The original survives as history, flagged reversed.
  SELECT status INTO v_status FROM public.journal_entries WHERE id = v_entry;
  IF v_status IS DISTINCT FROM 'reversed' THEN
    RAISE EXCEPTION 'original entry status is % (expected reversed)', v_status;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.journal_entry_lines WHERE journal_entry_id = v_entry) THEN
    RAISE EXCEPTION 'original journal lines were deleted by the reversal';
  END IF;

  -- Idempotent: a second void returns the same reversal, no new entry.
  IF public.void_journal_entry_atomic(v_entry, 'phase-0 regression test', NULL, NULL, CURRENT_DATE)
     IS DISTINCT FROM v_reversal THEN
    RAISE EXCEPTION 'repeat void produced a second reversal entry';
  END IF;

  RAISE NOTICE 'journal reversal scope invariants hold';
  RAISE EXCEPTION 'rollback: behavioural block complete'; -- force rollback
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM <> 'rollback: behavioural block complete' THEN
    RAISE;
  END IF;
END $$;

-- 6) Behavioural: voiding a PAID invoice — the reported failure — reverses the
--    revenue leg, the COGS leg and the cascaded payment in one transaction.
DO $$
DECLARE
  v_invoice uuid; v_org uuid; v_biz uuid;
  v_result jsonb;
  v_bad int;
  v_live_je int;
  v_status text;
BEGIN
  SELECT i.id, i.organization_id, i.business_id
    INTO v_invoice, v_org, v_biz
    FROM public.invoices i
   WHERE COALESCE(i.status::text, '') NOT IN ('voided', 'cancelled', 'draft')
     AND i.organization_id IS NOT NULL
     AND COALESCE(i.amount_paid, 0) > 0
   ORDER BY i.created_at DESC
   LIMIT 1;

  IF v_invoice IS NULL THEN
    RAISE NOTICE 'no eligible paid invoice — paid-invoice block skipped';
    RETURN;
  END IF;

  v_result := public.void_invoice_atomic(
    v_invoice, 'phase-0 regression test', CURRENT_DATE, NULL, true,
    'phase0:' || v_invoice::text
  );

  -- No reversal line anywhere in this invoice's journal trail may miss scope.
  SELECT count(*) INTO v_bad
    FROM public.journal_entry_lines l
    JOIN public.journal_entries je ON je.id = l.journal_entry_id
   WHERE je.source_type = 'invoice'
     AND je.source_id = v_invoice
     AND (l.organization_id IS NULL OR l.business_id IS NULL);
  IF v_bad > 0 THEN
    RAISE EXCEPTION '% journal lines on the voided invoice trail are missing scope columns', v_bad;
  END IF;

  -- Every journal entry sourced from the invoice is reversed — revenue and COGS.
  SELECT count(*) INTO v_live_je
    FROM public.journal_entries
   WHERE source_type = 'invoice' AND source_id = v_invoice
     AND COALESCE(is_reversal, false) = false
     AND status = 'posted';
  IF v_live_je > 0 THEN
    RAISE EXCEPTION '% invoice journal entries remain posted after the void', v_live_je;
  END IF;

  -- The cascade voided the settling payments rather than orphaning the cash.
  IF EXISTS (
    SELECT 1 FROM public.payments p
     WHERE p.id IN (SELECT payment_id FROM public.payment_allocations
                     WHERE invoice_id = v_invoice)
       AND COALESCE(p.status::text, 'completed') NOT IN ('voided', 'cancelled')
  ) THEN
    RAISE EXCEPTION 'payments settling the voided invoice are still live';
  END IF;

  SELECT status::text INTO v_status FROM public.invoices WHERE id = v_invoice;
  IF v_status NOT IN ('voided', 'cancelled') THEN
    RAISE EXCEPTION 'invoice status is % after void', v_status;
  END IF;

  RAISE NOTICE 'paid-invoice void invariants hold: %', v_result;
  RAISE EXCEPTION 'rollback: behavioural block complete'; -- force rollback
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM <> 'rollback: behavioural block complete' THEN
    RAISE;
  END IF;
END $$;
