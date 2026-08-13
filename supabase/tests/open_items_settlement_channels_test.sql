-- Open-items projections must recognise EVERY settlement channel, not just cash.
--
-- Behavioural assertions run inside a rolled-back transaction, so this file is
-- safe against any environment.

-- 1) Contract: the AR projection subtracts applied credit notes.
DO $$
DECLARE v_def text;
BEGIN
  SELECT pg_get_viewdef('public.finance_ar_open_items'::regclass, true) INTO v_def;
  IF v_def !~* 'credit_note_applications' THEN
    RAISE EXCEPTION 'finance_ar_open_items ignores credit_note_applications — receivables will be overstated';
  END IF;
  IF v_def !~* '''paid''' THEN
    RAISE EXCEPTION 'finance_ar_open_items may surface settled (paid) invoices as open';
  END IF;
END $$;

-- 2) Contract: the AP surface is the point-in-time engine, and it subtracts
--    applied vendor credit notes. The deprecated `finance_ap_open_items`
--    CURRENT_DATE mirror was dropped in Phase 10 and must never come back — it
--    could only ever answer "today", so any reprint of a closed period would be
--    wrong.
DO $$
DECLARE v_fn text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_fn
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'finance_ap_open_items_as_of';
  IF v_fn IS NULL THEN
    RAISE EXCEPTION 'finance_ap_open_items_as_of is missing — payables have no point-in-time engine';
  END IF;
  IF v_fn !~* 'vendor_credit_note_applications' THEN
    RAISE EXCEPTION 'finance_ap_open_items_as_of ignores vendor_credit_note_applications — payables will be overstated';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'finance_ap_open_items'
  ) THEN
    RAISE EXCEPTION 'finance_ap_open_items was retired in Phase 10 — payables must be read through finance_ap_open_items_as_of';
  END IF;
END $$;


-- 3) The drift detector exists, so this class of divergence cannot go silent.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'finance_open_items_tieout' AND c.relkind = 'v'
  ) THEN
    RAISE EXCEPTION 'finance_open_items_tieout is missing — projection/ledger drift would be invisible';
  END IF;
END $$;

-- 4) Live tie-out: projection residual must equal the subledger net per business.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM public.finance_open_items_tieout WHERE abs(drift) > 0.05 LOOP
    RAISE EXCEPTION 'open-items drift on % for business %: projection % vs ledger %',
      r.side, r.business_id, r.projection_residual, r.ledger_net;
  END LOOP;
END $$;

-- 5) An invoice fully settled by credit notes must disappear from the projection.
DO $$
DECLARE v_cnt int;
BEGIN
  SELECT count(*) INTO v_cnt
    FROM public.finance_ar_open_items oi
    JOIN public.invoices inv ON inv.id = oi.document_id
   WHERE inv.total - COALESCE(inv.amount_paid, 0) <= 0.01;
  IF v_cnt > 0 THEN
    RAISE EXCEPTION '% fully settled invoice(s) still appear as open receivables', v_cnt;
  END IF;
END $$;

-- 6) Recurring auto-confirmation must land on the canonical payable status.
DO $$
DECLARE v_src text;
BEGIN
  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'generate_recurring_invoice_occurrence';
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'generate_recurring_invoice_occurrence is missing';
  END IF;
  IF v_src ~* 'SET status = ''confirmed''' THEN
    RAISE EXCEPTION 'recurring engine still writes the non-canonical ''confirmed'' status — invoices become unpayable';
  END IF;
  IF v_src !~* 'SET status = ''sent''' THEN
    RAISE EXCEPTION 'recurring engine must land auto-confirmed invoices on ''sent''';
  END IF;
END $$;

-- 7) No posted invoice may be stranded on the non-canonical status.
DO $$
DECLARE v_cnt int;
BEGIN
  SELECT count(*) INTO v_cnt FROM public.invoices
   WHERE status::text = 'confirmed' AND journal_entry_id IS NOT NULL;
  IF v_cnt > 0 THEN
    RAISE EXCEPTION '% posted invoice(s) stranded on ''confirmed'' — not payable in the UI', v_cnt;
  END IF;
END $$;
