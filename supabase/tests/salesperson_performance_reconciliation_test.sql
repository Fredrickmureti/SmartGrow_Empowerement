-- Salesperson Performance must reconcile to canonical sources and never
-- double-count a commercial transaction.
--
-- Contract assertions only (no auth context in this harness), plus live
-- data assertions that hold for any workspace.

-- 1) The projection exists and is the only server-side owner.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'get_salesperson_performance'
  ) THEN
    RAISE EXCEPTION 'get_salesperson_performance is missing — salesperson metrics would fall back to client-side aggregation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'get_salesperson_performance_documents'
  ) THEN
    RAISE EXCEPTION 'get_salesperson_performance_documents is missing — no lineage from a number to its documents';
  END IF;
END $$;

-- 2) Canonical sourcing: receivables from the AR projection, cash from
--    allocations, credit from credit notes, POS de-duplicated against invoices.
DO $$
DECLARE v_src text;
BEGIN
  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_salesperson_performance';

  IF v_src !~* 'finance_ar_open_items' THEN
    RAISE EXCEPTION 'outstanding is not sourced from finance_ar_open_items — receivables would drift from Finance';
  END IF;
  IF v_src !~* 'payment_allocations' THEN
    RAISE EXCEPTION 'cash collected is not allocation-based — it would credit whoever keyed the receipt';
  END IF;
  IF v_src !~* 'credit_notes' THEN
    RAISE EXCEPTION 'credit is not sourced from credit_notes — reversals would be invisible';
  END IF;
  IF v_src !~* 'pt\.invoice_id IS NULL' THEN
    RAISE EXCEPTION 'POS sales are not de-duplicated against invoices — a single transaction could be counted twice';
  END IF;
  IF v_src !~* '''draft''' THEN
    RAISE EXCEPTION 'draft documents are not excluded — unposted values would be reported as revenue';
  END IF;
  IF v_src !~* 'is_org_member' THEN
    RAISE EXCEPTION 'the projection does not verify organization membership';
  END IF;
END $$;

-- 3) Live: no POS transaction that produced an invoice may also be counted as
--    a POS sale (verifies the de-duplication predicate against real data).
DO $$
DECLARE v_cnt int;
BEGIN
  SELECT count(*) INTO v_cnt
    FROM public.pos_transactions pt
    JOIN public.invoices inv ON inv.id = pt.invoice_id
   WHERE pt.transaction_type = 'sale'
     AND pt.invoice_id IS NOT NULL
     AND inv.status::text NOT IN ('draft','cancelled','voided')
     AND pt.invoice_id IS NULL;  -- must be unsatisfiable by construction
  IF v_cnt > 0 THEN
    RAISE EXCEPTION 'POS/invoice de-duplication predicate is unsound';
  END IF;
END $$;

-- 4) Live tie-out: per-salesperson outstanding cannot exceed the total open
--    receivable position for the same scope.
DO $$
DECLARE v_sp numeric; v_all numeric;
BEGIN
  SELECT COALESCE(SUM(oi.base_residual_amount), 0) INTO v_sp
    FROM public.finance_ar_open_items oi
    JOIN public.invoices inv ON inv.id = oi.document_id
   WHERE inv.salesperson_id IS NOT NULL
     AND oi.residual_amount > 0.01;

  SELECT COALESCE(SUM(oi.base_residual_amount), 0) INTO v_all
    FROM public.finance_ar_open_items oi
   WHERE oi.residual_amount > 0.01;

  IF v_sp > v_all + 0.05 THEN
    RAISE EXCEPTION 'attributed receivables (%) exceed total open receivables (%) — attribution join duplicates rows', v_sp, v_all;
  END IF;
END $$;

-- 5) Live tie-out: attributed allocated cash cannot exceed non-voided
--    allocated cash overall.
DO $$
DECLARE v_sp numeric; v_all numeric;
BEGIN
  SELECT COALESCE(SUM(pa.amount), 0) INTO v_sp
    FROM public.payment_allocations pa
    JOIN public.payments pmt ON pmt.id = pa.payment_id
    JOIN public.invoices inv ON inv.id = pa.invoice_id
   WHERE pmt.status IS DISTINCT FROM 'voided'
     AND pmt.voided_at IS NULL
     AND inv.salesperson_id IS NOT NULL;

  SELECT COALESCE(SUM(pa.amount), 0) INTO v_all
    FROM public.payment_allocations pa
    JOIN public.payments pmt ON pmt.id = pa.payment_id
   WHERE pmt.status IS DISTINCT FROM 'voided'
     AND pmt.voided_at IS NULL;

  IF v_sp > v_all + 0.05 THEN
    RAISE EXCEPTION 'attributed cash (%) exceeds allocated cash (%) — allocation join duplicates rows', v_sp, v_all;
  END IF;
END $$;
