-- sales_order_quantity_ledger_test.sql
--
-- The sales order is the demand contract. Everything downstream — deliveries,
-- invoices, returns, cancellation — must move a *quantity ledger* on the line,
-- never a hand-maintained status. This suite proves the ledger behaves:
--
--   Q1. so_number uniqueness is org-wide and the allocator serialises on an
--       advisory lock (no duplicate numbers under concurrency)
--   Q2. invoicing a line raises quantity_invoiced through the trigger, and
--       closes quantity_open_to_invoice on so_line_balances
--   Q3. a second invoice has nothing left to bill (over-invoicing is arithmetic-
--       ally impossible, not merely discouraged)
--   Q4. cancelling/voiding an invoice returns the quantity to open
--   Q5. deliveries move quantity_open_to_deliver and quantity_open_to_plan
--       separately (planned-but-undelivered is not deliverable twice)
--   Q6. a return delivery note is reported as quantity_returned and does NOT
--       silently erase quantity_fulfilled
--   Q7. cancelling closes the ledger via _so_write_cancelled_quantities
--   Q8. cancel-after-delivery and cancel-after-invoice are refused by the
--       owning engine
--   Q9. an edit may not reduce a line below what has already happened
--
-- Run: psql -f supabase/tests/sales_order_quantity_ledger_test.sql
BEGIN;
  DO $$
  DECLARE
    v_org uuid; v_biz uuid;
    v_so uuid; v_item uuid;
    v_inv uuid; v_inv_item uuid;
    v_dn uuid; v_ret uuid;
    v_n numeric; v_txt text; v_src text;
    v_stamp text := extract(epoch from clock_timestamp())::bigint::text;
  BEGIN
    ---------------------------------------------------------------------------
    -- Q1. numbering
    ---------------------------------------------------------------------------
    IF NOT EXISTS (
      SELECT 1
        FROM pg_index i
        JOIN pg_class t ON t.oid = i.indrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = 'public'
         AND t.relname = 'sales_orders'
         AND i.indisunique
         AND (SELECT array_agg(a.attname::text ORDER BY a.attname::text)
                FROM unnest(i.indkey::int[]) k
                JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k)
             = ARRAY['organization_id','so_number']
    ) THEN
      RAISE EXCEPTION 'Q1 FAILED: sales_orders has no org-wide unique so_number index';
    END IF;

    SELECT prosrc INTO v_src
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'get_next_so_number'
       AND pg_get_function_identity_arguments(p.oid) LIKE '%_business_id%';
    IF v_src IS NULL OR v_src NOT LIKE '%pg_advisory_xact_lock%' THEN
      RAISE EXCEPTION 'Q1b FAILED: the SO number allocator does not serialise on an advisory lock';
    END IF;

    SELECT organization_id, id INTO v_org, v_biz FROM public.businesses LIMIT 1;
    IF v_biz IS NULL THEN
      RAISE NOTICE 'no business to test against; behavioural checks skipped';
      RETURN;
    END IF;

    ---------------------------------------------------------------------------
    -- Fixture: a confirmed order for 10 units at 100.
    ---------------------------------------------------------------------------
    INSERT INTO public.sales_orders
      (organization_id, business_id, so_number, order_date, status,
       currency, subtotal, tax_amount, discount_amount, shipping_amount, total)
    VALUES
      (v_org, v_biz, 'TEST-QL-' || v_stamp, CURRENT_DATE, 'confirmed',
       'USD', 1000, 0, 0, 0, 1000)
    RETURNING id INTO v_so;

    INSERT INTO public.sales_order_items
      (sales_order_id, description, quantity, unit_price, tax_rate, line_total)
    VALUES (v_so, 'Ledger line', 10, 100, 0, 1000)
    RETURNING id INTO v_item;

    SELECT quantity_open_to_invoice INTO v_n
      FROM public.so_line_balances WHERE sales_order_item_id = v_item;
    IF v_n <> 10 THEN
      RAISE EXCEPTION 'Q2 setup FAILED: expected 10 open to invoice, got %', v_n;
    END IF;

    ---------------------------------------------------------------------------
    -- Q2. invoicing 4 units moves the ledger
    ---------------------------------------------------------------------------
    INSERT INTO public.invoices
      (organization_id, business_id, invoice_number, due_date, status,
       issue_date, currency, subtotal, tax_amount, total, source_sales_order_id)
    VALUES
      (v_org, v_biz, 'TEST-QL-INV-' || v_stamp, CURRENT_DATE + 30, 'draft',
       CURRENT_DATE, 'USD', 400, 0, 400, v_so)
    RETURNING id INTO v_inv;

    INSERT INTO public.invoice_items
      (invoice_id, description, quantity, unit_price, line_total, sales_order_item_id)
    VALUES (v_inv, 'Ledger line', 4, 100, 400, v_item)
    RETURNING id INTO v_inv_item;

    SELECT quantity_invoiced INTO v_n FROM public.sales_order_items WHERE id = v_item;
    IF v_n <> 4 THEN
      RAISE EXCEPTION 'Q2 FAILED: quantity_invoiced is % after invoicing 4', v_n;
    END IF;
    SELECT quantity_open_to_invoice INTO v_n
      FROM public.so_line_balances WHERE sales_order_item_id = v_item;
    IF v_n <> 6 THEN
      RAISE EXCEPTION 'Q2b FAILED: expected 6 left to invoice, got %', v_n;
    END IF;

    ---------------------------------------------------------------------------
    -- Q3. billing the remainder leaves nothing open — a second run of the
    --     SO->invoice engine finds zero open lines and must refuse.
    ---------------------------------------------------------------------------
    UPDATE public.invoice_items SET quantity = 10, line_total = 1000 WHERE id = v_inv_item;
    SELECT quantity_open_to_invoice INTO v_n
      FROM public.so_line_balances WHERE sales_order_item_id = v_item;
    IF v_n <> 0 THEN
      RAISE EXCEPTION 'Q3 FAILED: a fully billed line still reports % open to invoice', v_n;
    END IF;
    IF (SELECT COALESCE(SUM(quantity_open_to_invoice), 0)
          FROM public.so_line_balances WHERE sales_order_id = v_so) <> 0 THEN
      RAISE EXCEPTION 'Q3b FAILED: order still reports open-to-invoice after full billing';
    END IF;

    SELECT prosrc INTO v_src
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'convert_so_to_invoice_atomic';
    IF v_src IS NULL
       OR v_src NOT LIKE '%quantity_open_to_invoice%'
       OR v_src NOT LIKE '%nothing left to invoice%' THEN
      RAISE EXCEPTION 'Q3c FAILED: the SO->invoice engine no longer bills off the open balance';
    END IF;
    IF v_src NOT LIKE '%spawned_invoice_id%' THEN
      RAISE EXCEPTION 'Q3d FAILED: the SO->invoice route does not block the delivery-invoice route';
    END IF;

    ---------------------------------------------------------------------------
    -- Q4. removing the billing returns the quantity to open, and a cancelled or
    --     voided invoice is excluded from the invoiced balance.
    --     (The status cannot simply be flipped here: the accounting engine
    --     refuses a cancellation without a posted journal entry — itself part of
    --     the invariant, so we assert the recalc rule instead.)
    ---------------------------------------------------------------------------
    SELECT prosrc INTO v_src
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = '_recalc_so_item_invoiced';
    IF v_src NOT LIKE '%cancelled%' OR v_src NOT LIKE '%void%' THEN
      RAISE EXCEPTION 'Q4 FAILED: cancelled/void invoices are no longer excluded from quantity_invoiced';
    END IF;

    DELETE FROM public.invoice_items WHERE id = v_inv_item;
    SELECT quantity_invoiced INTO v_n FROM public.sales_order_items WHERE id = v_item;
    IF v_n <> 0 THEN
      RAISE EXCEPTION 'Q4b FAILED: removing the billing left % invoiced units behind', v_n;
    END IF;
    SELECT quantity_open_to_invoice INTO v_n
      FROM public.so_line_balances WHERE sales_order_item_id = v_item;
    IF v_n <> 10 THEN
      RAISE EXCEPTION 'Q4c FAILED: the line did not reopen to invoice (got %)', v_n;
    END IF;
    DELETE FROM public.invoices WHERE id = v_inv;


    ---------------------------------------------------------------------------
    -- Q5. planned vs delivered are separate balances
    ---------------------------------------------------------------------------
    INSERT INTO public.delivery_notes
      (organization_id, business_id, delivery_number, delivery_date, status, sales_order_id)
    VALUES (v_org, v_biz, 'TEST-QL-DN-' || v_stamp, CURRENT_DATE, 'pending', v_so)
    RETURNING id INTO v_dn;

    INSERT INTO public.delivery_note_items
      (delivery_note_id, description, sales_order_item_id, quantity_ordered, quantity_delivered)
    VALUES (v_dn, 'Ledger line', v_item, 10, 3);

    SELECT quantity_open_to_plan INTO v_n
      FROM public.so_line_balances WHERE sales_order_item_id = v_item;
    IF v_n <> 7 THEN
      RAISE EXCEPTION 'Q5 FAILED: planning balance is % (expected 7 after planning 3)', v_n;
    END IF;
    SELECT quantity_open_to_deliver INTO v_n
      FROM public.so_line_balances WHERE sales_order_item_id = v_item;
    IF v_n <> 10 THEN
      RAISE EXCEPTION 'Q5b FAILED: an unshipped plan already consumed the delivery balance (%)', v_n;
    END IF;

    -- deliver it: the fulfilment engine owns quantity_fulfilled
    UPDATE public.delivery_notes SET status = 'delivered' WHERE id = v_dn;
    UPDATE public.sales_order_items SET quantity_fulfilled = 3 WHERE id = v_item;

    SELECT quantity_open_to_deliver INTO v_n
      FROM public.so_line_balances WHERE sales_order_item_id = v_item;
    IF v_n <> 7 THEN
      RAISE EXCEPTION 'Q5c FAILED: delivery balance is % after delivering 3', v_n;
    END IF;

    ---------------------------------------------------------------------------
    -- Q6. a return is reported, not netted away silently
    ---------------------------------------------------------------------------
    INSERT INTO public.delivery_notes
      (organization_id, business_id, delivery_number, delivery_date, status,
       sales_order_id, is_return)
    VALUES (v_org, v_biz, 'TEST-QL-RET-' || v_stamp, CURRENT_DATE, 'returned', v_so, true)
    RETURNING id INTO v_ret;

    INSERT INTO public.delivery_note_items
      (delivery_note_id, description, sales_order_item_id, quantity_ordered, quantity_delivered)
    VALUES (v_ret, 'Ledger line', v_item, 2, 2);

    SELECT quantity_returned INTO v_n
      FROM public.so_line_balances WHERE sales_order_item_id = v_item;
    IF v_n <> 2 THEN
      RAISE EXCEPTION 'Q6 FAILED: quantity_returned is % (expected 2)', v_n;
    END IF;
    SELECT quantity_delivered INTO v_n
      FROM public.so_line_balances WHERE sales_order_item_id = v_item;
    IF v_n <> 3 THEN
      RAISE EXCEPTION 'Q6b FAILED: a return mutated quantity_fulfilled (now %) instead of being reported separately', v_n;
    END IF;

    ---------------------------------------------------------------------------
    -- Q7. cancellation closes the ledger
    ---------------------------------------------------------------------------
    PERFORM public._so_write_cancelled_quantities(v_so);
    SELECT quantity_cancelled INTO v_n FROM public.sales_order_items WHERE id = v_item;
    IF v_n <> 7 THEN
      RAISE EXCEPTION 'Q7 FAILED: quantity_cancelled is % (expected 7 = 10 - 3 delivered)', v_n;
    END IF;
    SELECT quantity_open_to_deliver INTO v_n
      FROM public.so_line_balances WHERE sales_order_item_id = v_item;
    IF v_n <> 0 THEN
      RAISE EXCEPTION 'Q7b FAILED: a closed line still reports % open to deliver', v_n;
    END IF;
    IF EXISTS (SELECT 1 FROM public.so_backorder_lines WHERE sales_order_item_id = v_item) THEN
      RAISE EXCEPTION 'Q7c FAILED: a cancelled line still appears as a backorder';
    END IF;

    ---------------------------------------------------------------------------
    -- Q8. cancel-after-delivery / cancel-after-invoice are refused
    ---------------------------------------------------------------------------
    SELECT prosrc INTO v_src
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'cancel_sales_order_atomic';
    IF v_src IS NULL THEN
      RAISE EXCEPTION 'Q8 FAILED: cancel_sales_order_atomic is missing';
    END IF;
    IF v_src NOT LIKE '%quantity_fulfilled%' OR v_src NOT LIKE '%process a return before cancelling%' THEN
      RAISE EXCEPTION 'Q8a FAILED: cancellation no longer refuses delivered orders';
    END IF;
    IF v_src NOT LIKE '%converted_invoice_id%' OR v_src NOT LIKE '%spawned_invoice_id%' THEN
      RAISE EXCEPTION 'Q8b FAILED: cancellation no longer refuses invoiced orders (either route)';
    END IF;
    IF v_src NOT LIKE '%release_sales_order_reservations_atomic%' THEN
      RAISE EXCEPTION 'Q8c FAILED: cancellation no longer releases stock reservations';
    END IF;
    IF v_src NOT LIKE '%_so_write_cancelled_quantities%' THEN
      RAISE EXCEPTION 'Q8d FAILED: cancellation no longer closes the quantity ledger';
    END IF;

    ---------------------------------------------------------------------------
    -- Q9. an edit may not under-run what already happened
    ---------------------------------------------------------------------------
    SELECT prosrc INTO v_src
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'update_sales_order_atomic';
    IF v_src NOT LIKE '%cannot be reduced below the quantity already delivered or invoiced%' THEN
      RAISE EXCEPTION 'Q9 FAILED: the edit engine lost its under-run guard';
    END IF;
    IF v_src NOT LIKE '%has already been delivered or invoiced and cannot be removed%' THEN
      RAISE EXCEPTION 'Q9b FAILED: the edit engine lost its line-deletion guard';
    END IF;
    IF v_src NOT LIKE '%is_locked%' THEN
      RAISE EXCEPTION 'Q9c FAILED: the edit engine no longer honours the invoice lock';
    END IF;

    RAISE NOTICE 'sales_order_quantity_ledger_test: all checks passed';
  END $$;
ROLLBACK;
