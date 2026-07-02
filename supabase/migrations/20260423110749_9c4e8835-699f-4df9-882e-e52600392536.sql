-- ============================================================
-- PHASE 2 — Currency + cross-company hardening
-- ============================================================

-- 2.1 record_payment_atomic — derive currency from invoice (with business fallback)
CREATE OR REPLACE FUNCTION public.record_payment_atomic(
  _org_id uuid, _business_id uuid, _invoice_id uuid, _contact_id uuid,
  _amount numeric, _payment_date date,
  _payment_method text DEFAULT 'bank_transfer'::text,
  _reference text DEFAULT NULL::text,
  _notes text DEFAULT NULL::text,
  _receipt_number text DEFAULT NULL::text,
  _created_by uuid DEFAULT NULL::uuid,
  _deposit_account_id uuid DEFAULT NULL::uuid,
  _receivable_account_id uuid DEFAULT NULL::uuid,
  _je_entry_number text DEFAULT NULL::text,
  _customer_credit_account_id uuid DEFAULT NULL::uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_payment_id UUID;
  v_invoice RECORD;
  v_balance_due NUMERIC;
  v_overpayment NUMERIC := 0;
  v_applied_to_invoice NUMERIC;
  v_new_amount_paid NUMERIC;
  v_new_status invoice_status;
  v_je_id UUID;
  v_je_number TEXT;
  v_result JSONB;
  v_retry INT := 0;
  v_max_retries INT := 5;
  v_credit_note_id UUID;
  v_cn_number TEXT;
  v_currency TEXT;
BEGIN
  IF _deposit_account_id IS NULL THEN
    RAISE EXCEPTION 'Deposit account is required. Cannot record payment without a valid GL deposit account.';
  END IF;
  IF _receivable_account_id IS NULL THEN
    RAISE EXCEPTION 'Accounts Receivable account is required. Cannot record payment without a valid AR account.';
  END IF;

  SELECT id, invoice_number, total, amount_paid, status, currency, business_id
    INTO v_invoice
    FROM invoices
   WHERE id = _invoice_id
     AND organization_id = _org_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found';
  END IF;

  -- Phase 2: currency comes from the invoice; fallback to business; final fallback USD
  v_currency := COALESCE(
    NULLIF(v_invoice.currency, ''),
    (SELECT base_currency FROM businesses WHERE id = COALESCE(v_invoice.business_id, _business_id)),
    'USD'
  );

  v_balance_due := v_invoice.total - COALESCE(v_invoice.amount_paid, 0);

  IF _amount > v_balance_due THEN
    v_applied_to_invoice := v_balance_due;
    v_overpayment := _amount - v_balance_due;
  ELSE
    v_applied_to_invoice := _amount;
    v_overpayment := 0;
  END IF;

  IF v_overpayment > 0 AND _customer_credit_account_id IS NULL THEN
    RAISE EXCEPTION 'Customer credit account not configured. Cannot process overpayment of %. Please configure the Customer Deposits & Advances account in Finance Settings.', v_overpayment;
  END IF;

  INSERT INTO payments (
    organization_id, business_id, invoice_id, contact_id, amount,
    payment_date, payment_method, reference, notes, receipt_number, created_by,
    deposit_account_id
  ) VALUES (
    _org_id, _business_id, _invoice_id, _contact_id, _amount,
    _payment_date, _payment_method::payment_method, _reference, _notes, _receipt_number, _created_by,
    _deposit_account_id
  ) RETURNING id INTO v_payment_id;

  v_new_amount_paid := COALESCE(v_invoice.amount_paid, 0) + v_applied_to_invoice;
  IF v_new_amount_paid >= v_invoice.total THEN
    v_new_status := 'paid'::invoice_status;
  ELSE
    v_new_status := 'partial'::invoice_status;
  END IF;

  LOOP
    BEGIN
      v_je_number := generate_next_je_number(_org_id);

      INSERT INTO journal_entries (
        organization_id, business_id, entry_number, entry_date,
        reference, description, source_type, source_id, status, created_by
      ) VALUES (
        _org_id, _business_id, v_je_number,
        _payment_date, 'PMT-' || v_invoice.invoice_number,
        'Payment for invoice ' || v_invoice.invoice_number,
        'payment', v_payment_id, 'posted', _created_by
      ) RETURNING id INTO v_je_id;

      EXIT;
    EXCEPTION WHEN unique_violation THEN
      v_retry := v_retry + 1;
      IF v_retry >= v_max_retries THEN
        RAISE EXCEPTION 'Could not generate unique JE number after % retries', v_max_retries;
      END IF;
    END;
  END LOOP;

  INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description)
  VALUES (v_je_id, _deposit_account_id, _amount, 0, 'Payment received - ' || v_invoice.invoice_number);

  INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description)
  VALUES (v_je_id, _receivable_account_id, 0, v_applied_to_invoice, 'AR settlement - ' || v_invoice.invoice_number);

  IF v_overpayment > 0 THEN
    INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description)
    VALUES (v_je_id, _customer_credit_account_id, 0, v_overpayment, 'Customer overpayment credit - ' || v_invoice.invoice_number);
  END IF;

  UPDATE payments SET journal_entry_id = v_je_id, status = 'applied' WHERE id = v_payment_id;

  UPDATE invoices SET amount_paid = v_new_amount_paid, status = v_new_status WHERE id = _invoice_id;

  IF v_overpayment > 0 THEN
    SELECT generate_next_credit_note_number(_org_id) INTO v_cn_number;
    INSERT INTO credit_notes (
      organization_id, business_id, contact_id, credit_note_number,
      issue_date, total, amount_applied, status, currency, notes, created_by
    ) VALUES (
      _org_id, _business_id, _contact_id, v_cn_number,
      _payment_date, v_overpayment, 0, 'issued'::credit_note_status,
      v_currency, 'Auto-issued from overpayment on ' || v_invoice.invoice_number, _created_by
    ) RETURNING id INTO v_credit_note_id;
  END IF;

  v_result := jsonb_build_object(
    'success', true,
    'payment_id', v_payment_id,
    'journal_entry_id', v_je_id,
    'applied_to_invoice', v_applied_to_invoice,
    'overpayment', v_overpayment,
    'credit_note_id', v_credit_note_id,
    'new_status', v_new_status::text,
    'currency', v_currency
  );
  RETURN v_result;
END;
$function$;

-- 2.2 add source_sales_order_id to invoices for SO drill-down + business-match enforcement
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS source_sales_order_id uuid REFERENCES public.sales_orders(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_invoices_source_sales_order_id
  ON public.invoices(source_sales_order_id)
  WHERE source_sales_order_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.enforce_invoice_so_business_match()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_so_business_id uuid;
  v_so_org_id uuid;
BEGIN
  IF NEW.source_sales_order_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT business_id, organization_id
    INTO v_so_business_id, v_so_org_id
    FROM sales_orders
   WHERE id = NEW.source_sales_order_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Source sales order % does not exist', NEW.source_sales_order_id;
  END IF;

  IF v_so_org_id <> NEW.organization_id THEN
    RAISE EXCEPTION 'Invoice organization (%) does not match source sales order organization (%)',
      NEW.organization_id, v_so_org_id;
  END IF;

  IF v_so_business_id IS NOT NULL AND NEW.business_id IS NOT NULL
     AND v_so_business_id <> NEW.business_id THEN
    RAISE EXCEPTION 'Invoice business (%) does not match source sales order business (%)',
      NEW.business_id, v_so_business_id;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_enforce_invoice_so_business_match ON public.invoices;
CREATE TRIGGER trg_enforce_invoice_so_business_match
  BEFORE INSERT OR UPDATE OF source_sales_order_id, business_id, organization_id
  ON public.invoices
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_invoice_so_business_match();

-- ============================================================
-- PHASE 3 — RLS cleanup + sales_order_status enum
-- ============================================================

-- 3.1 Drop legacy duplicate RLS policies on estimates
DROP POLICY IF EXISTS "Users can view estimates in their orgs" ON public.estimates;
DROP POLICY IF EXISTS "Users can create estimates in their orgs" ON public.estimates;
DROP POLICY IF EXISTS "Users can update estimates in their orgs" ON public.estimates;
DROP POLICY IF EXISTS "Users can delete estimates" ON public.estimates;
-- subscription gate is fine to keep — overlays the perm policy
-- the "Subscription active check for insert on estimates" stays.

-- 3.2 sales_order_status enum (additive — text column kept, but constrained via CHECK)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'sales_order_status') THEN
    CREATE TYPE public.sales_order_status AS ENUM (
      'draft','confirmed','processing','partial','fulfilled','invoiced','cancelled'
    );
  END IF;
END $$;

-- Apply CHECK constraint instead of column-type change to avoid breaking existing
-- consumers that still treat status as text. Enum is available for future use.
ALTER TABLE public.sales_orders
  DROP CONSTRAINT IF EXISTS sales_orders_status_check;
ALTER TABLE public.sales_orders
  ADD CONSTRAINT sales_orders_status_check
  CHECK (status IN ('draft','confirmed','processing','partial','fulfilled','invoiced','cancelled'));

-- 3.3 DB-level guard: block deletion of non-draft sales orders
CREATE OR REPLACE FUNCTION public.enforce_sales_order_delete_status()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'Cannot delete sales order % with status %. Only draft orders can be deleted.',
      OLD.so_number, OLD.status;
  END IF;
  RETURN OLD;
END;
$function$;

DROP TRIGGER IF EXISTS trg_enforce_sales_order_delete_status ON public.sales_orders;
CREATE TRIGGER trg_enforce_sales_order_delete_status
  BEFORE DELETE ON public.sales_orders
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_sales_order_delete_status();

-- ============================================================
-- PHASE 5 — Odoo-grade SO lifecycle: lock + reservations
-- ============================================================

-- 5.1 is_locked column + auto-lock trigger when invoice created from SO
ALTER TABLE public.sales_orders
  ADD COLUMN IF NOT EXISTS is_locked boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.lock_sales_order_on_invoice_link()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.converted_invoice_id IS NOT NULL
     AND (OLD.converted_invoice_id IS NULL OR OLD.converted_invoice_id <> NEW.converted_invoice_id) THEN
    NEW.is_locked := true;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_lock_sales_order_on_invoice_link ON public.sales_orders;
CREATE TRIGGER trg_lock_sales_order_on_invoice_link
  BEFORE UPDATE OF converted_invoice_id ON public.sales_orders
  FOR EACH ROW
  EXECUTE FUNCTION public.lock_sales_order_on_invoice_link();

-- 5.2 Block edits to locked SOs (allow status, lock-flag, and converted_* fields only)
CREATE OR REPLACE FUNCTION public.enforce_sales_order_lock()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  -- Allow the lock transition itself + status, conversion, and timestamp updates
  IF OLD.is_locked = true THEN
    IF NEW.subtotal <> OLD.subtotal
       OR NEW.tax_amount <> OLD.tax_amount
       OR NEW.discount_amount <> OLD.discount_amount
       OR NEW.shipping_amount <> OLD.shipping_amount
       OR NEW.total <> OLD.total
       OR NEW.contact_id IS DISTINCT FROM OLD.contact_id
       OR NEW.currency <> OLD.currency THEN
      RAISE EXCEPTION 'Sales order % is locked (already invoiced). Cannot modify financial fields.',
        OLD.so_number;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_enforce_sales_order_lock ON public.sales_orders;
CREATE TRIGGER trg_enforce_sales_order_lock
  BEFORE UPDATE ON public.sales_orders
  FOR EACH ROW
  WHEN (OLD.is_locked = true)
  EXECUTE FUNCTION public.enforce_sales_order_lock();

-- 5.3 confirm_sales_order_atomic — header status + per-line stock reservation in one tx
CREATE OR REPLACE FUNCTION public.confirm_sales_order_atomic(
  p_so_id uuid,
  p_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_so          RECORD;
  v_warehouse_id uuid;
  v_item        RECORD;
  v_reservations_created int := 0;
  v_reservations_skipped int := 0;
BEGIN
  SELECT id, organization_id, business_id, branch_id, status, so_number
    INTO v_so
    FROM sales_orders
   WHERE id = p_so_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sales order not found');
  END IF;

  IF v_so.status NOT IN ('draft') THEN
    RETURN jsonb_build_object('success', false, 'error',
      'Only draft sales orders can be confirmed. Current status: ' || v_so.status);
  END IF;

  -- Resolve a warehouse for the SO's branch (may be null for HQ-context orders)
  SELECT id INTO v_warehouse_id
    FROM warehouses
   WHERE organization_id = v_so.organization_id
     AND business_id = v_so.business_id
     AND COALESCE(branch_id, '00000000-0000-0000-0000-000000000000'::uuid)
         = COALESCE(v_so.branch_id, '00000000-0000-0000-0000-000000000000'::uuid)
     AND is_active = true
     AND COALESCE(is_in_transit, false) = false
   ORDER BY is_default DESC NULLS LAST
   LIMIT 1;

  -- Iterate items and reserve where possible (skip non-inventory items silently)
  IF v_warehouse_id IS NOT NULL THEN
    FOR v_item IN
      SELECT soi.product_id, soi.quantity, soi.quantity_fulfilled,
             p.track_inventory
        FROM sales_order_items soi
        LEFT JOIN products p ON p.id = soi.product_id
       WHERE soi.sales_order_id = p_so_id
         AND soi.product_id IS NOT NULL
         AND COALESCE(p.track_inventory, false) = true
         AND (soi.quantity - COALESCE(soi.quantity_fulfilled, 0)) > 0
    LOOP
      BEGIN
        PERFORM create_stock_reservation(
          v_so.organization_id,
          v_item.product_id,
          v_warehouse_id,
          v_item.quantity - COALESCE(v_item.quantity_fulfilled, 0),
          'sales_order',
          p_so_id,
          NULL,
          NULL
        );
        v_reservations_created := v_reservations_created + 1;
      EXCEPTION WHEN OTHERS THEN
        -- Out-of-stock or other reservation failure: skip but continue confirmation
        v_reservations_skipped := v_reservations_skipped + 1;
      END;
    END LOOP;
  END IF;

  UPDATE sales_orders
     SET status = 'confirmed',
         updated_at = now()
   WHERE id = p_so_id;

  RETURN jsonb_build_object(
    'success', true,
    'so_id', p_so_id,
    'reservations_created', v_reservations_created,
    'reservations_skipped', v_reservations_skipped,
    'warehouse_resolved', v_warehouse_id IS NOT NULL
  );
END;
$function$;

-- 5.4 release_sales_order_reservations_atomic — release on cancel
CREATE OR REPLACE FUNCTION public.release_sales_order_reservations_atomic(
  p_so_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_org_id uuid;
  v_count  int := 0;
  v_res    RECORD;
BEGIN
  SELECT organization_id INTO v_org_id FROM sales_orders WHERE id = p_so_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sales order not found');
  END IF;

  FOR v_res IN
    SELECT id FROM stock_reservations
     WHERE organization_id = v_org_id
       AND source_type = 'sales_order'
       AND source_id = p_so_id
       AND status = 'active'
  LOOP
    PERFORM release_stock_reservation(v_org_id, v_res.id);
    v_count := v_count + 1;
  END LOOP;

  RETURN jsonb_build_object('success', true, 'released', v_count);
END;
$function$;

-- 5.5 complete_delivery_atomic — also update SO line fulfillment in same tx
CREATE OR REPLACE FUNCTION public.complete_delivery_atomic(
  p_dn_id uuid, p_user_id uuid, p_received_by text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_dn               RECORD;
  v_so_branch_id     uuid;
  v_warehouse_id     uuid;
  v_branch_id        uuid;
  v_org_id           uuid;
  v_biz_id           uuid;
  v_item             RECORD;
  v_unit_cost        numeric;
  v_line_cost        numeric;
  v_total_cogs       numeric := 0;
  v_inventory_acct   uuid;
  v_cogs_acct        uuid;
  v_journal_id       uuid;
  v_movement_count   int := 0;
  v_so_id            uuid;
  v_all_fulfilled    boolean;
  v_any_fulfilled    boolean;
BEGIN
  SELECT id, organization_id, business_id, branch_id, sales_order_id,
         delivery_number, status
    INTO v_dn
    FROM delivery_notes
   WHERE id = p_dn_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Delivery note not found');
  END IF;

  IF v_dn.status = 'delivered' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Delivery already marked');
  END IF;

  v_org_id := v_dn.organization_id;
  v_biz_id := v_dn.business_id;
  v_so_id  := v_dn.sales_order_id;

  SELECT id, branch_id INTO v_warehouse_id, v_branch_id
    FROM warehouses
   WHERE organization_id = v_org_id
     AND business_id = v_biz_id
     AND COALESCE(branch_id, '00000000-0000-0000-0000-000000000000'::uuid)
         = COALESCE(v_dn.branch_id, '00000000-0000-0000-0000-000000000000'::uuid)
     AND is_active = true
     AND COALESCE(is_in_transit, false) = false
   ORDER BY is_default DESC NULLS LAST
   LIMIT 1;

  IF v_warehouse_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error',
      'No active warehouse found for this branch — create one before delivering.');
  END IF;

  IF v_so_id IS NOT NULL THEN
    SELECT branch_id INTO v_so_branch_id FROM sales_orders WHERE id = v_so_id;
    IF v_so_branch_id IS NOT NULL
       AND v_branch_id IS NOT NULL
       AND v_so_branch_id <> v_branch_id THEN
      RETURN jsonb_build_object('success', false, 'error',
        'Sales order is in a different branch than the warehouse — pick a warehouse in the SO branch or transfer the order.');
    END IF;
  END IF;

  FOR v_item IN
    SELECT dni.id, dni.product_id, dni.description, dni.quantity_delivered,
           dni.sales_order_item_id,
           p.cost_price, p.track_inventory,
           p.inventory_account_id, p.cogs_account_id
      FROM delivery_note_items dni
 LEFT JOIN products p ON p.id = dni.product_id
     WHERE dni.delivery_note_id = p_dn_id
       AND dni.quantity_delivered > 0
  LOOP
    -- Phase 5: update SO line fulfillment atomically
    IF v_item.sales_order_item_id IS NOT NULL THEN
      UPDATE sales_order_items
         SET quantity_fulfilled = COALESCE(quantity_fulfilled, 0) + v_item.quantity_delivered
       WHERE id = v_item.sales_order_item_id;
    END IF;

    IF v_item.product_id IS NULL OR NOT COALESCE(v_item.track_inventory, true) THEN
      CONTINUE;
    END IF;

    v_unit_cost := COALESCE(v_item.cost_price, 0);

    INSERT INTO stock_movements (
      organization_id, business_id, branch_id, warehouse_id,
      product_id, movement_type, quantity, unit_cost,
      reference_type, reference_id, notes, created_by
    ) VALUES (
      v_org_id, v_biz_id, v_branch_id, v_warehouse_id,
      v_item.product_id, 'delivery',
      -ABS(v_item.quantity_delivered),
      v_unit_cost,
      'delivery_note', p_dn_id,
      'Delivery ' || v_dn.delivery_number || COALESCE(' — ' || v_item.description, ''),
      p_user_id
    );

    v_movement_count := v_movement_count + 1;
    v_line_cost := ABS(v_item.quantity_delivered) * v_unit_cost;
    v_total_cogs := v_total_cogs + v_line_cost;
  END LOOP;

  -- COGS GL: DR COGS / CR Inventory
  IF v_total_cogs > 0 THEN
    SELECT id INTO v_inventory_acct
      FROM accounts
     WHERE organization_id = v_org_id
       AND business_id = v_biz_id
       AND detail_type = 'inventory'
       AND is_active = true
     LIMIT 1;

    SELECT id INTO v_cogs_acct
      FROM accounts
     WHERE organization_id = v_org_id
       AND business_id = v_biz_id
       AND detail_type = 'cost_of_goods_sold'
       AND is_active = true
     LIMIT 1;

    IF v_inventory_acct IS NOT NULL AND v_cogs_acct IS NOT NULL THEN
      INSERT INTO journal_entries (
        organization_id, business_id, entry_date, reference, memo,
        source_type, source_id, status, created_by
      ) VALUES (
        v_org_id, v_biz_id, CURRENT_DATE,
        'COGS-' || v_dn.delivery_number,
        'COGS for delivery ' || v_dn.delivery_number,
        'delivery_note', p_dn_id, 'posted', p_user_id
      ) RETURNING id INTO v_journal_id;

      INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description)
      VALUES (v_journal_id, v_cogs_acct, v_total_cogs, 0, 'COGS - ' || v_dn.delivery_number);

      INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description)
      VALUES (v_journal_id, v_inventory_acct, 0, v_total_cogs, 'Inventory reduction - ' || v_dn.delivery_number);
    END IF;
  END IF;

  -- Mark DN as delivered
  UPDATE delivery_notes
     SET status = 'delivered',
         delivered_at = now(),
         received_by = p_received_by,
         updated_at = now()
   WHERE id = p_dn_id;

  -- Phase 5: roll up SO status from its line fulfillment
  IF v_so_id IS NOT NULL THEN
    SELECT
      bool_and(quantity_fulfilled >= quantity),
      bool_or(quantity_fulfilled > 0)
      INTO v_all_fulfilled, v_any_fulfilled
      FROM sales_order_items
     WHERE sales_order_id = v_so_id;

    IF v_all_fulfilled THEN
      UPDATE sales_orders SET status = 'fulfilled', updated_at = now()
       WHERE id = v_so_id AND status NOT IN ('invoiced','cancelled');
    ELSIF v_any_fulfilled THEN
      UPDATE sales_orders SET status = 'partial', updated_at = now()
       WHERE id = v_so_id AND status NOT IN ('invoiced','cancelled','fulfilled');
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'movements_created', v_movement_count,
    'gl_posted', v_total_cogs > 0,
    'cogs_total', v_total_cogs
  );
END;
$function$;
