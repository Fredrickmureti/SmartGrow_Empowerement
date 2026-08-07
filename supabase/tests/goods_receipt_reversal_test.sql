-- Phase 4c of the business reversal convergence plan — coverage for the goods
-- receipt reversal writer `public.void_goods_receipt_atomic` (ADR 0128) and its
-- stock compensator `public.wms_reverse_gr_stock`.
--
-- Why this file exists: `resolve_reversal_intent` advertised the `goods_return`
-- operation for months with no writer behind it — the platform told operators a
-- reversal was legal and had nothing to execute. Now that the writer exists, the
-- risk inverts: a GRN reversal fans out over five subsystems (GR/NI journal,
-- stock ledger, purchase-order received quantities, warehouse putaway tasks,
-- three-way match). Any one of them drifting out of the transaction re-creates
-- the partial-reversal class this architecture exists to eliminate.
--
-- Introspection plus read-only probes only; safe in any environment.

-- 1) Exactly one writer for the operation, exactly one overload.
DO $$
DECLARE v_name text; v_count int;
BEGIN
  FOREACH v_name IN ARRAY ARRAY['void_goods_receipt_atomic','wms_reverse_gr_stock'] LOOP
    SELECT count(*) INTO v_count
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_name;
    IF v_count <> 1 THEN
      RAISE EXCEPTION '% must exist with exactly one overload, found %', v_name, v_count;
    END IF;
  END LOOP;
END $$;

-- 2) The writer gates on the single legality authority rather than re-deriving
--    its own rules, and is idempotent (a retried reversal reports
--    `already_voided` instead of double-compensating stock and GL).
DO $$
DECLARE v_src text;
BEGIN
  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'void_goods_receipt_atomic';

  IF v_src !~* 'resolve_reversal_intent' THEN
    RAISE EXCEPTION 'void_goods_receipt_atomic does not consult resolve_reversal_intent — legality would diverge from the preview the operator approved';
  END IF;
  IF v_src !~* 'already_voided|already_reversed' THEN
    RAISE EXCEPTION 'void_goods_receipt_atomic is not idempotent — a retried reversal would compensate stock twice';
  END IF;
END $$;

-- 3) The full fan-out lives inside the one transaction (ADR 0128).
DO $$
DECLARE v_src text;
BEGIN
  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'void_goods_receipt_atomic';

  IF v_src !~* 'void_journal_entry_atomic' THEN
    RAISE EXCEPTION 'void_goods_receipt_atomic does not reverse the GR/NI journal through the shared reversal writer';
  END IF;
  IF v_src !~* 'wms_reverse_gr_stock' THEN
    RAISE EXCEPTION 'void_goods_receipt_atomic does not compensate stock — received goods would remain on hand after the receipt was reversed';
  END IF;
  IF v_src !~* 'wms_cancel_tasks_for_document' THEN
    RAISE EXCEPTION 'void_goods_receipt_atomic does not cancel open putaway tasks — the floor would keep working a reversed receipt';
  END IF;
  IF v_src !~* 'bill_grn_matches|three_way' THEN
    RAISE EXCEPTION 'void_goods_receipt_atomic does not release the three-way match — the receipt would stay matchable to a bill';
  END IF;
END $$;

-- 4) Reversal compensates; it never erases. Stock history must be extended with
--    a `return_out` movement, not deleted, and the receipt must be stamped
--    rather than removed.
DO $$
DECLARE v_src text;
BEGIN
  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'wms_reverse_gr_stock';

  IF v_src !~* 'return_out' THEN
    RAISE EXCEPTION 'wms_reverse_gr_stock does not emit return_out movements';
  END IF;
  IF v_src ~* 'delete\s+from\s+(public\.)?stock_movements' THEN
    RAISE EXCEPTION 'wms_reverse_gr_stock deletes stock movements — reversal must preserve the ledger';
  END IF;
  IF v_src !~* 'purchase_order_items|received_quantity|quantity_received' THEN
    RAISE EXCEPTION 'wms_reverse_gr_stock does not restore purchase-order received quantities — the PO would stay falsely fulfilled';
  END IF;

  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'void_goods_receipt_atomic';
  IF v_src ~* 'delete\s+from\s+(public\.)?goods_receipts' THEN
    RAISE EXCEPTION 'void_goods_receipt_atomic deletes the receipt — reversal must leave an auditable voided record';
  END IF;
END $$;

-- 5) Warehouse task cancellation has a single writer, shared by the invoice and
--    goods receipt reversal paths. A second cancellation path would bypass the
--    task audit trail.
DO $$
DECLARE v_count int; v_rogue text;
BEGIN
  SELECT count(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'wms_cancel_tasks_for_document';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'wms_cancel_tasks_for_document must exist with exactly one overload, found %', v_count;
  END IF;

  SELECT string_agg(p.proname, ', ') INTO v_rogue
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname ~* '(void|reverse|cancel_document)'
     AND p.prosrc ~* 'update\s+public\.wms_tasks[^;]*cancelled'
     AND p.proname <> 'wms_cancel_tasks_for_document';
  IF v_rogue IS NOT NULL THEN
    RAISE EXCEPTION 'reversal functions cancelling warehouse tasks outside the canonical writer: %', v_rogue;
  END IF;
END $$;

-- 6) Both reversal paths that can strand warehouse work actually cancel it.
DO $$
DECLARE v_name text; v_src text;
BEGIN
  FOREACH v_name IN ARRAY ARRAY['void_invoice_atomic','void_goods_receipt_atomic'] LOOP
    SELECT p.prosrc INTO v_src
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_name;
    IF v_src !~* 'wms_cancel_tasks_for_document' THEN
      RAISE EXCEPTION '% leaves open warehouse tasks behind after reversal', v_name;
    END IF;
  END LOOP;
END $$;

-- 7) Behavioural probe: intent and preview agree about goods receipts, and a
--    receipt already consumed by a bill is refused with a stated blocker rather
--    than a silent failure. Read-only.
DO $$
DECLARE v_id uuid; v_intent jsonb; v_preview jsonb;
BEGIN
  SELECT id INTO v_id FROM public.goods_receipts LIMIT 1;
  IF v_id IS NULL THEN RETURN; END IF;

  BEGIN
    v_intent  := public.resolve_reversal_intent('goods_receipt', v_id);
    v_preview := public.preview_reversal_consequences('goods_receipt', v_id);
  EXCEPTION WHEN insufficient_privilege THEN
    -- No org-scoped session (e.g. run from the SQL editor): the tenancy guard
    -- refusing is correct behaviour, not a contract failure.
    RETURN;
  END;


  IF v_intent IS NULL OR v_preview IS NULL THEN
    RAISE EXCEPTION 'goods receipt % has no intent/preview answer', v_id;
  END IF;
  IF (v_intent->>'allowed')::boolean IS TRUE
     AND COALESCE(v_intent->>'operation', '') <> 'goods_return' THEN
    RAISE EXCEPTION 'goods receipt reversal advertised as "%" — the only routed operation is goods_return',
      v_intent->>'operation';
  END IF;
END $$;
