
-- ============================================================================
-- POS STAGE 4 — Returns engine de-decoration
-- ============================================================================

-- 1. Reasons taxonomy ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.pos_return_reasons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  label text NOT NULL,
  requires_note boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.pos_return_reasons ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated can read return reasons" ON public.pos_return_reasons;
CREATE POLICY "Authenticated can read return reasons"
  ON public.pos_return_reasons FOR SELECT
  TO authenticated USING (true);

-- Writes restricted to platform admins (has_role checked if available).
DROP POLICY IF EXISTS "Platform admin manages return reasons" ON public.pos_return_reasons;
CREATE POLICY "Platform admin manages return reasons"
  ON public.pos_return_reasons FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.role::text IN ('platform_admin','admin')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.role::text IN ('platform_admin','admin')
    )
  );

INSERT INTO public.pos_return_reasons (code, label, requires_note, sort_order)
VALUES
  ('defective',             'Defective / faulty',     false, 10),
  ('wrong_item',            'Wrong item delivered',   false, 20),
  ('customer_changed_mind', 'Customer changed mind',  false, 30),
  ('expired',               'Expired product',        false, 40),
  ('price_match',           'Price match / re-pricing', false, 50),
  ('other',                 'Other (note required)',  true,  99)
ON CONFLICT (code) DO NOTHING;

-- 2. New columns on pos_transaction_items ------------------------------------
ALTER TABLE public.pos_transaction_items
  ADD COLUMN IF NOT EXISTS original_item_id uuid
    REFERENCES public.pos_transaction_items(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS return_reason_id uuid
    REFERENCES public.pos_return_reasons(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS return_reason_note text;

CREATE INDEX IF NOT EXISTS pos_transaction_items_original_item_idx
  ON public.pos_transaction_items(original_item_id)
  WHERE original_item_id IS NOT NULL;

-- 3. New column on pos_security_settings -------------------------------------
ALTER TABLE public.pos_security_settings
  ADD COLUMN IF NOT EXISTS return_requires_manager_above_amount numeric(12,2)
    NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.pos_security_settings.return_requires_manager_above_amount IS
  'POS Stage 4: manager PIN required when refund total exceeds this amount. Combined with the boolean require_manager_pin_for_return (always-on switch).';

-- 4. v_pos_returnable_qty -----------------------------------------------------
CREATE OR REPLACE VIEW public.v_pos_returnable_qty AS
SELECT
  ti.id                                         AS original_item_id,
  ti.transaction_id                             AS original_transaction_id,
  ti.product_id,
  ti.description,
  ti.unit_price,
  ti.tax_rate,
  ti.cost_price,
  ti.quantity                                   AS sold_qty,
  COALESCE((
    SELECT SUM(rti.quantity)
    FROM public.pos_transaction_items rti
    JOIN public.pos_transactions rt ON rt.id = rti.transaction_id
    WHERE rti.original_item_id = ti.id
      AND rt.transaction_type = 'return'
      AND rt.status = 'completed'
  ), 0)                                         AS returned_qty,
  GREATEST(
    ti.quantity - COALESCE((
      SELECT SUM(rti.quantity)
      FROM public.pos_transaction_items rti
      JOIN public.pos_transactions rt ON rt.id = rti.transaction_id
      WHERE rti.original_item_id = ti.id
        AND rt.transaction_type = 'return'
        AND rt.status = 'completed'
    ), 0),
    0
  )                                             AS returnable_qty
FROM public.pos_transaction_items ti
JOIN public.pos_transactions t ON t.id = ti.transaction_id
WHERE t.transaction_type = 'sale'
  AND t.status = 'completed';

GRANT SELECT ON public.v_pos_returnable_qty TO authenticated;

-- 5. Void/return separation trigger ------------------------------------------
CREATE OR REPLACE FUNCTION public.pos_block_void_return_overlap()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_has_returns int;
BEGIN
  -- Block voiding a transaction that already has return lines.
  IF NEW.status = 'voided' AND COALESCE(OLD.status, '') <> 'voided' THEN
    SELECT COUNT(*) INTO v_has_returns
    FROM public.pos_transactions r
    WHERE r.original_transaction_id = NEW.id
      AND r.transaction_type = 'return'
      AND r.status = 'completed';
    IF v_has_returns > 0 THEN
      RAISE EXCEPTION 'Cannot void transaction %: % return(s) already processed', NEW.id, v_has_returns
        USING ERRCODE = 'check_violation', HINT = 'void_blocked_by_return';
    END IF;
  END IF;

  -- Block creating a return for a voided original.
  IF TG_OP = 'INSERT' AND NEW.transaction_type = 'return' AND NEW.original_transaction_id IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM public.pos_transactions o
      WHERE o.id = NEW.original_transaction_id
        AND o.status = 'voided'
    ) THEN
      RAISE EXCEPTION 'Cannot create return for voided transaction %', NEW.original_transaction_id
        USING ERRCODE = 'check_violation', HINT = 'return_blocked_by_void';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pos_block_void_return_overlap ON public.pos_transactions;
CREATE TRIGGER trg_pos_block_void_return_overlap
  BEFORE INSERT OR UPDATE OF status ON public.pos_transactions
  FOR EACH ROW
  EXECUTE FUNCTION public.pos_block_void_return_overlap();

-- 6. Updated process_pos_return RPC ------------------------------------------
CREATE OR REPLACE FUNCTION public.process_pos_return(
  p_organization_id uuid,
  p_register_id uuid,
  p_shift_id uuid,
  p_original_transaction_id uuid,
  p_items jsonb,
  p_refund_method text DEFAULT 'cash'::text,
  p_notes text DEFAULT NULL::text,
  p_created_by uuid DEFAULT NULL::uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_transaction_id UUID;
  v_transaction_number TEXT;
  v_register_code TEXT;
  v_register_branch_id UUID;
  v_register_business_id UUID;
  v_register_org_id UUID;
  v_shift_warehouse_id UUID;
  v_default_warehouse_id UUID;
  v_item JSONB;
  v_product_id UUID;
  v_quantity NUMERIC;
  v_track_inventory BOOLEAN;
  v_subtotal NUMERIC := 0;
  v_tax_amount NUMERIC := 0;
  v_total NUMERIC := 0;
  v_item_index INT := 0;
  v_original_status TEXT;
  v_original_business_id UUID;
  v_original_item_id UUID;
  v_returnable NUMERIC;
  v_item_total NUMERIC;
  v_item_tax NUMERIC;
  v_reason_id UUID;
  v_reason_code TEXT;
  v_reason_requires_note BOOLEAN;
  v_reason_note TEXT;
  v_unit_price NUMERIC;
  v_tax_rate NUMERIC;
  v_cost_price NUMERIC;
  v_description TEXT;
BEGIN
  -- Register is the single source of truth for (org, business, branch).
  SELECT register_code, branch_id, business_id, organization_id
    INTO v_register_code, v_register_branch_id, v_register_business_id, v_register_org_id
  FROM public.pos_registers
  WHERE id = p_register_id;

  IF v_register_code IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_register', 'details', 'Register not found');
  END IF;

  IF v_register_org_id IS DISTINCT FROM p_organization_id THEN
    RAISE EXCEPTION 'Register % belongs to a different organization than supplied', p_register_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_register_branch_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_register', 'details', 'Register has no branch context');
  END IF;

  -- Validate original.
  SELECT status, business_id INTO v_original_status, v_original_business_id
  FROM public.pos_transactions
  WHERE id = p_original_transaction_id
    AND organization_id = p_organization_id;

  IF v_original_status IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'original_not_found', 'details', 'Original transaction not found');
  END IF;

  IF v_original_status = 'voided' THEN
    RETURN jsonb_build_object('success', false, 'error', 'original_voided',
      'details', 'Cannot return a voided transaction');
  END IF;

  IF v_original_status != 'completed' THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_status',
      'details', 'Original transaction is not completed (status: ' || v_original_status || ')');
  END IF;

  IF v_original_business_id IS DISTINCT FROM v_register_business_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'cross_company_return',
      'details', 'Original transaction belongs to a different company than this register');
  END IF;

  -- Resolve warehouse (shift → branch default).
  SELECT warehouse_id INTO v_shift_warehouse_id
  FROM public.pos_shifts
  WHERE id = p_shift_id
    AND organization_id = v_register_org_id
    AND business_id     = v_register_business_id
    AND register_id     = p_register_id;

  v_default_warehouse_id := v_shift_warehouse_id;

  IF v_default_warehouse_id IS NULL THEN
    SELECT id INTO v_default_warehouse_id
    FROM public.warehouses
    WHERE organization_id = v_register_org_id
      AND business_id     = v_register_business_id
      AND branch_id       = v_register_branch_id
      AND is_active       = true
    ORDER BY is_default DESC, created_at ASC
    LIMIT 1;
  END IF;

  -- Per-item validation: returnable qty + reason.
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_original_item_id := (v_item->>'original_item_id')::UUID;
    v_quantity := (v_item->>'quantity')::NUMERIC;

    IF v_original_item_id IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'missing_original_item',
        'details', 'Each return line must reference an original_item_id');
    END IF;

    IF v_quantity IS NULL OR v_quantity <= 0 THEN
      RETURN jsonb_build_object('success', false, 'error', 'invalid_quantity',
        'details', 'Return quantity must be greater than zero');
    END IF;

    -- v_pos_returnable_qty is the single source of truth.
    SELECT returnable_qty INTO v_returnable
    FROM public.v_pos_returnable_qty
    WHERE original_item_id = v_original_item_id
      AND original_transaction_id = p_original_transaction_id;

    IF v_returnable IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'item_not_found',
        'details', 'Original item not found on this transaction');
    END IF;

    IF v_quantity > v_returnable THEN
      RETURN jsonb_build_object('success', false, 'error', 'over_return',
        'details', format('Cannot return %s — only %s remaining for this line', v_quantity, v_returnable));
    END IF;

    -- Reason validation.
    v_reason_id := NULLIF(v_item->>'return_reason_id','')::UUID;
    IF v_reason_id IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'missing_reason',
        'details', 'A return reason is required for every line');
    END IF;

    SELECT code, requires_note INTO v_reason_code, v_reason_requires_note
    FROM public.pos_return_reasons
    WHERE id = v_reason_id AND is_active = true;

    IF v_reason_code IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'invalid_reason',
        'details', 'Selected return reason is not valid');
    END IF;

    v_reason_note := NULLIF(trim(coalesce(v_item->>'return_reason_note','')), '');

    IF v_reason_requires_note AND v_reason_note IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'reason_note_required',
        'details', format('Reason "%s" requires an explanatory note', v_reason_code));
    END IF;

    IF NOT v_reason_requires_note AND v_reason_note IS NOT NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'reason_note_not_allowed',
        'details', 'Free-text note only allowed for reason code "other"');
    END IF;
  END LOOP;

  v_transaction_number := public.get_next_pos_transaction_number(p_organization_id, v_register_code);

  -- Totals (use historical price/tax from snapshot via the original line).
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_original_item_id := (v_item->>'original_item_id')::UUID;
    v_quantity := (v_item->>'quantity')::NUMERIC;

    SELECT unit_price, tax_rate
      INTO v_unit_price, v_tax_rate
    FROM public.v_pos_returnable_qty
    WHERE original_item_id = v_original_item_id;

    v_item_total := v_unit_price * v_quantity;
    v_item_tax   := v_item_total * COALESCE(v_tax_rate, 0) / 100;
    v_subtotal   := v_subtotal + v_item_total;
    v_tax_amount := v_tax_amount + v_item_tax;
  END LOOP;
  v_total := v_subtotal + v_tax_amount;

  -- Create return transaction.
  INSERT INTO public.pos_transactions (
    id, organization_id, business_id, branch_id, register_id, shift_id, transaction_number,
    transaction_type, original_transaction_id,
    subtotal, tax_amount, discount_amount, total,
    payment_status, status, completed_at, created_by, notes, created_at
  ) VALUES (
    gen_random_uuid(), p_organization_id, v_register_business_id, v_register_branch_id,
    p_register_id, p_shift_id, v_transaction_number,
    'return', p_original_transaction_id,
    v_subtotal, v_tax_amount, 0, v_total,
    'refunded', 'completed', now(), p_created_by,
    COALESCE(p_notes, '') || ' Return for txn ' || p_original_transaction_id::TEXT, now()
  ) RETURNING id INTO v_transaction_id;

  -- Insert return items + stock movements (reads historical price/tax/cost
  -- from v_pos_returnable_qty so refunds match the original sale).
  v_item_index := 0;
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_original_item_id := (v_item->>'original_item_id')::UUID;
    v_quantity := (v_item->>'quantity')::NUMERIC;
    v_reason_id := (v_item->>'return_reason_id')::UUID;
    v_reason_note := NULLIF(trim(coalesce(v_item->>'return_reason_note','')), '');

    SELECT product_id, unit_price, tax_rate, cost_price, description
      INTO v_product_id, v_unit_price, v_tax_rate, v_cost_price, v_description
    FROM public.v_pos_returnable_qty
    WHERE original_item_id = v_original_item_id;

    v_item_total := v_unit_price * v_quantity;
    v_item_tax   := v_item_total * COALESCE(v_tax_rate, 0) / 100;

    INSERT INTO public.pos_transaction_items (
      transaction_id, product_id, description, quantity,
      unit_price, discount_type, discount_value,
      tax_rate, tax_amount, line_total, cost_price, sort_order,
      original_item_id, return_reason_id, return_reason_note
    ) VALUES (
      v_transaction_id, v_product_id, v_description, v_quantity,
      v_unit_price, NULL, 0,
      COALESCE(v_tax_rate, 0), v_item_tax, v_item_total + v_item_tax,
      v_cost_price, v_item_index,
      v_original_item_id, v_reason_id, v_reason_note
    );

    IF v_product_id IS NOT NULL THEN
      SELECT track_inventory INTO v_track_inventory
      FROM public.products
      WHERE id = v_product_id
        AND organization_id = p_organization_id
        AND business_id     = v_register_business_id;

      IF v_track_inventory = true THEN
        IF v_default_warehouse_id IS NULL THEN
          RAISE EXCEPTION 'No active warehouse for POS register branch %; create one before processing returns', v_register_branch_id
            USING ERRCODE = 'check_violation';
        END IF;

        INSERT INTO public.stock_movements (
          organization_id, business_id, branch_id, product_id, warehouse_id,
          movement_type, quantity, unit_cost,
          reference_type, reference_id, notes, created_by, movement_date
        ) VALUES (
          p_organization_id, v_register_business_id, v_register_branch_id,
          v_product_id, v_default_warehouse_id,
          'pos_return', v_quantity,
          COALESCE(v_cost_price, 0),
          'pos_transaction', v_transaction_id,
          'POS Return: ' || v_transaction_number,
          p_created_by,
          now()
        );
      END IF;
    END IF;

    v_item_index := v_item_index + 1;
  END LOOP;

  -- Refund payment record.
  INSERT INTO public.pos_transaction_payments (
    transaction_id, payment_method, amount, reference, status
  ) VALUES (
    v_transaction_id,
    CASE WHEN p_refund_method = 'store_credit' THEN 'voucher' ELSE p_refund_method END,
    -v_total,
    'Refund - ' || v_transaction_number,
    'completed'
  );

  IF p_refund_method = 'cash' THEN
    UPDATE public.pos_shifts
    SET expected_cash = COALESCE(expected_cash, 0) - v_total,
        total_returns = COALESCE(total_returns, 0) + v_total,
        updated_at    = now()
    WHERE id = p_shift_id;
  ELSE
    UPDATE public.pos_shifts
    SET total_returns = COALESCE(total_returns, 0) + v_total,
        updated_at    = now()
    WHERE id = p_shift_id;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'transaction_id', v_transaction_id,
    'transaction_number', v_transaction_number,
    'refund_amount', v_total,
    'business_id', v_register_business_id,
    'branch_id', v_register_branch_id
  );
END;
$function$;
