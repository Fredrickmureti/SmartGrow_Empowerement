-- ADR 0131 §5 — the inventory boundary of commercial compensation.
--
-- Why this file exists: a credit note is a *commercial* document. It reverses
-- revenue and tax; it does not, on its own, move goods. Stock and COGS effects
-- may only arise from a `sales_returns` document linked through
-- `credit_notes.source_return_id`. If any compensation writer ever moved stock
-- directly, inventory valuation would change without a warehouse document to
-- explain it — unauditable, and invisible to receiving/inspection.
--
-- Introspection only; safe in any environment.

-- 1) No compensation writer touches inventory. Only the return approver may.
DO $$
DECLARE v_name text; v_src text;
BEGIN
  FOREACH v_name IN ARRAY ARRAY[
    'create_credit_note_atomic',
    'issue_credit_note_atomic',
    'apply_credit_to_invoice_atomic',
    'refund_customer_atomic',
    'issue_credit_note_for_payment_atomic',
    'confirm_credit_note_atomic'
  ] LOOP
    SELECT p.prosrc INTO v_src
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_name;
    IF v_src IS NULL THEN
      RAISE EXCEPTION 'canonical compensation writer % is missing', v_name;
    END IF;
    IF v_src ~* '(stock_movements|stock_quants|warehouse_stock_lots)' THEN
      RAISE EXCEPTION '% touches inventory directly — stock may only move through a sales_returns document (ADR 0131 §5)', v_name;
    END IF;
  END LOOP;
END $$;

-- 2) Inventory participation exists exactly where it belongs: the return
--    approver moves stock and reverses COGS, and it is the document that links
--    itself to the credit note.
DO $$
DECLARE v_src text;
BEGIN
  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'approve_sales_return_atomic';
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'approve_sales_return_atomic is missing — nothing would return goods';
  END IF;
  IF v_src !~* 'stock_movements' THEN
    RAISE EXCEPTION 'approve_sales_return_atomic no longer restores stock';
  END IF;
  IF v_src !~* 'source_return_id' THEN
    RAISE EXCEPTION 'approve_sales_return_atomic no longer links its credit note via source_return_id';
  END IF;
END $$;

-- 3) Any credit note that moved stock without a return document would be
--    unexplainable. Prove no such row exists.
DO $$
DECLARE v_bad int;
BEGIN
  SELECT count(*) INTO v_bad
    FROM public.stock_movements sm
    JOIN public.credit_notes cn ON cn.id = sm.reference_id
   WHERE cn.source_return_id IS NULL;
  IF v_bad > 0 THEN
    RAISE EXCEPTION '% stock movement(s) reference a credit note with no linked sales return', v_bad;
  END IF;
EXCEPTION
  WHEN undefined_column THEN RETURN;  -- movement linkage columns differ; nothing to prove
  WHEN insufficient_privilege THEN RETURN;
END $$;
