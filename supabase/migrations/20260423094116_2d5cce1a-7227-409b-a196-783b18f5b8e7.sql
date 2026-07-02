
-- =============================================================
-- PHASE 2: SCHEMA HARDENING
-- =============================================================

ALTER TABLE public.stock_adjustments
  ADD COLUMN IF NOT EXISTS allow_negative boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS warehouse_id uuid REFERENCES public.warehouses(id) ON DELETE SET NULL;

ALTER TABLE public.warehouse_stock
  DROP CONSTRAINT IF EXISTS warehouse_stock_warehouse_id_product_id_key;

ALTER TABLE public.warehouse_stock
  DROP CONSTRAINT IF EXISTS warehouse_stock_warehouse_product_unique;

UPDATE public.warehouse_stock ws
   SET business_id = w.business_id
  FROM public.warehouses w
 WHERE ws.warehouse_id = w.id
   AND ws.business_id IS NULL
   AND w.business_id IS NOT NULL;

ALTER TABLE public.warehouse_stock
  ADD CONSTRAINT warehouse_stock_business_warehouse_product_unique
  UNIQUE (business_id, warehouse_id, product_id);

CREATE TABLE IF NOT EXISTS public.default_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  purpose text NOT NULL,
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, purpose)
);

ALTER TABLE public.default_accounts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "default_accounts_select" ON public.default_accounts;
CREATE POLICY "default_accounts_select" ON public.default_accounts
  FOR SELECT USING (
    public.user_can_access_business(auth.uid(), business_id)
    AND public.user_has_module_permission(auth.uid(), organization_id, 'financials'::text, 'read'::text)
  );

DROP POLICY IF EXISTS "default_accounts_insert" ON public.default_accounts;
CREATE POLICY "default_accounts_insert" ON public.default_accounts
  FOR INSERT WITH CHECK (
    public.user_can_access_business(auth.uid(), business_id)
    AND public.user_has_module_permission(auth.uid(), organization_id, 'financials'::text, 'write'::text)
  );

DROP POLICY IF EXISTS "default_accounts_update" ON public.default_accounts;
CREATE POLICY "default_accounts_update" ON public.default_accounts
  FOR UPDATE USING (
    public.user_can_access_business(auth.uid(), business_id)
    AND public.user_has_module_permission(auth.uid(), organization_id, 'financials'::text, 'write'::text)
  );

DROP POLICY IF EXISTS "default_accounts_delete" ON public.default_accounts;
CREATE POLICY "default_accounts_delete" ON public.default_accounts
  FOR DELETE USING (
    public.user_can_access_business(auth.uid(), business_id)
    AND public.user_has_module_permission(auth.uid(), organization_id, 'financials'::text, 'delete'::text)
  );

CREATE OR REPLACE FUNCTION public.set_default_accounts_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS trg_default_accounts_updated_at ON public.default_accounts;
CREATE TRIGGER trg_default_accounts_updated_at
  BEFORE UPDATE ON public.default_accounts
  FOR EACH ROW EXECUTE FUNCTION public.set_default_accounts_updated_at();

CREATE OR REPLACE FUNCTION public.resolve_default_account(
  p_business_id uuid,
  p_purpose text
) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_account_id uuid;
  v_org_id uuid;
BEGIN
  SELECT account_id INTO v_account_id
    FROM public.default_accounts
   WHERE business_id = p_business_id AND purpose = p_purpose;
  IF v_account_id IS NOT NULL THEN RETURN v_account_id; END IF;

  SELECT organization_id INTO v_org_id FROM public.businesses WHERE id = p_business_id;

  IF p_purpose = 'inventory' THEN
    SELECT id INTO v_account_id FROM public.accounts
     WHERE business_id = p_business_id AND organization_id = v_org_id
       AND is_active = true
       AND (detail_type = 'inventory' OR LOWER(name) LIKE '%inventory%' OR code LIKE '12%')
     ORDER BY (detail_type = 'inventory') DESC, code LIMIT 1;
  ELSIF p_purpose = 'inventory_adjustment' THEN
    SELECT id INTO v_account_id FROM public.accounts
     WHERE business_id = p_business_id AND organization_id = v_org_id
       AND is_active = true
       AND (detail_type IN ('inventory_adjustment','operating_expenses')
            OR LOWER(name) LIKE '%adjustment%')
     ORDER BY (detail_type = 'inventory_adjustment') DESC, code LIMIT 1;
  ELSIF p_purpose = 'opening_equity' THEN
    SELECT id INTO v_account_id FROM public.accounts
     WHERE business_id = p_business_id AND organization_id = v_org_id
       AND account_type = 'equity' AND is_active = true
       AND (LOWER(name) LIKE '%opening%' OR LOWER(name) LIKE '%retained%' OR code LIKE '3%')
     ORDER BY code LIMIT 1;
  END IF;

  RETURN v_account_id;
END;
$$;

-- =============================================================
-- PHASE 1: CRITICAL CORRECTNESS FIXES
-- =============================================================

CREATE OR REPLACE FUNCTION public.update_product_stock()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_wh_new RECORD;
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.products
       SET stock_quantity = COALESCE(stock_quantity, 0) + NEW.quantity
     WHERE id = NEW.product_id;

    IF NEW.warehouse_id IS NOT NULL THEN
      SELECT business_id, branch_id INTO v_wh_new
        FROM public.warehouses WHERE id = NEW.warehouse_id;
      INSERT INTO public.warehouse_stock (
        organization_id, business_id, branch_id,
        warehouse_id, product_id, quantity, reserved_quantity
      ) VALUES (
        NEW.organization_id, v_wh_new.business_id, v_wh_new.branch_id,
        NEW.warehouse_id, NEW.product_id, NEW.quantity, 0
      )
      ON CONFLICT (business_id, warehouse_id, product_id) DO UPDATE
        SET quantity = COALESCE(public.warehouse_stock.quantity, 0) + EXCLUDED.quantity,
            updated_at = now();
    END IF;

  ELSIF TG_OP = 'DELETE' THEN
    UPDATE public.products
       SET stock_quantity = COALESCE(stock_quantity, 0) - OLD.quantity
     WHERE id = OLD.product_id;

    IF OLD.warehouse_id IS NOT NULL THEN
      UPDATE public.warehouse_stock
         SET quantity = COALESCE(quantity, 0) - OLD.quantity,
             updated_at = now()
       WHERE warehouse_id = OLD.warehouse_id
         AND product_id   = OLD.product_id;
    END IF;

  ELSIF TG_OP = 'UPDATE' THEN
    UPDATE public.products
       SET stock_quantity = COALESCE(stock_quantity, 0) - OLD.quantity + NEW.quantity
     WHERE id = NEW.product_id;

    IF OLD.warehouse_id IS NOT NULL
       AND NEW.warehouse_id IS NOT NULL
       AND OLD.warehouse_id = NEW.warehouse_id THEN
      SELECT business_id, branch_id INTO v_wh_new
        FROM public.warehouses WHERE id = NEW.warehouse_id;
      INSERT INTO public.warehouse_stock (
        organization_id, business_id, branch_id,
        warehouse_id, product_id, quantity, reserved_quantity
      ) VALUES (
        NEW.organization_id, v_wh_new.business_id, v_wh_new.branch_id,
        NEW.warehouse_id, NEW.product_id, NEW.quantity - OLD.quantity, 0
      )
      ON CONFLICT (business_id, warehouse_id, product_id) DO UPDATE
        SET quantity = COALESCE(public.warehouse_stock.quantity, 0) + (NEW.quantity - OLD.quantity),
            updated_at = now();
    ELSE
      IF OLD.warehouse_id IS NOT NULL THEN
        UPDATE public.warehouse_stock
           SET quantity = COALESCE(quantity, 0) - OLD.quantity,
               updated_at = now()
         WHERE warehouse_id = OLD.warehouse_id
           AND product_id   = OLD.product_id;
      END IF;
      IF NEW.warehouse_id IS NOT NULL THEN
        SELECT business_id, branch_id INTO v_wh_new
          FROM public.warehouses WHERE id = NEW.warehouse_id;
        INSERT INTO public.warehouse_stock (
          organization_id, business_id, branch_id,
          warehouse_id, product_id, quantity, reserved_quantity
        ) VALUES (
          NEW.organization_id, v_wh_new.business_id, v_wh_new.branch_id,
          NEW.warehouse_id, NEW.product_id, NEW.quantity, 0
        )
        ON CONFLICT (business_id, warehouse_id, product_id) DO UPDATE
          SET quantity = COALESCE(public.warehouse_stock.quantity, 0) + EXCLUDED.quantity,
              updated_at = now();
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.validate_stock_movement_quantity()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_available_qty numeric;
  v_allow_negative boolean := false;
  v_adj_id uuid;
BEGIN
  IF NEW.quantity >= 0 THEN
    RETURN NEW;
  END IF;

  IF NEW.movement_type IN ('count', 'migration') THEN
    RETURN NEW;
  END IF;

  IF NEW.warehouse_id IS NULL THEN
    RAISE EXCEPTION 'stock_movements.warehouse_id is required (movement_type=%)', NEW.movement_type;
  END IF;

  IF NEW.movement_type = 'adjustment' AND NEW.reference_type = 'stock_adjustment' THEN
    v_adj_id := NEW.reference_id;
    IF v_adj_id IS NOT NULL THEN
      SELECT COALESCE(allow_negative, false) INTO v_allow_negative
        FROM public.stock_adjustments WHERE id = v_adj_id;
      IF COALESCE(v_allow_negative, false) THEN
        RETURN NEW;
      END IF;
    END IF;
  END IF;

  SELECT COALESCE(ws.quantity, 0) - COALESCE(ws.reserved_quantity, 0)
    INTO v_available_qty
    FROM warehouse_stock ws
   WHERE ws.warehouse_id = NEW.warehouse_id
     AND ws.product_id = NEW.product_id;

  IF v_available_qty IS NULL THEN
    v_available_qty := 0;
  END IF;

  IF (v_available_qty + NEW.quantity) < 0 THEN
    RAISE EXCEPTION 'Insufficient stock in warehouse. Available: %, Requested: %',
      v_available_qty, ABS(NEW.quantity);
  END IF;

  RETURN NEW;
END;
$$;

DROP FUNCTION IF EXISTS public.get_available_stock(uuid, uuid);
CREATE OR REPLACE FUNCTION public.get_available_stock(
  p_product_id uuid,
  p_warehouse_id uuid DEFAULT NULL,
  p_business_id uuid DEFAULT NULL,
  p_branch_id uuid DEFAULT NULL
) RETURNS numeric
LANGUAGE plpgsql STABLE SET search_path TO 'public' AS $$
DECLARE
  v_stock numeric := 0;
BEGIN
  IF p_warehouse_id IS NOT NULL THEN
    SELECT COALESCE(quantity, 0) - COALESCE(reserved_quantity, 0)
      INTO v_stock
      FROM warehouse_stock
     WHERE product_id = p_product_id
       AND warehouse_id = p_warehouse_id;
    RETURN COALESCE(v_stock, 0);
  END IF;

  IF p_business_id IS NULL THEN
    RAISE EXCEPTION 'get_available_stock requires either p_warehouse_id or p_business_id';
  END IF;

  SELECT COALESCE(SUM(COALESCE(ws.quantity,0) - COALESCE(ws.reserved_quantity,0)), 0)
    INTO v_stock
    FROM warehouse_stock ws
    JOIN warehouses w ON w.id = ws.warehouse_id
   WHERE ws.product_id = p_product_id
     AND ws.business_id = p_business_id
     AND COALESCE(w.is_in_transit, false) = false
     AND (p_branch_id IS NULL OR ws.branch_id = p_branch_id);

  RETURN COALESCE(v_stock, 0);
END;
$$;

CREATE OR REPLACE FUNCTION public.release_stock(
  p_organization_id uuid,
  p_product_id uuid,
  p_warehouse_id uuid,
  p_quantity numeric
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_wh RECORD;
  v_current_reserved numeric;
BEGIN
  SELECT business_id, organization_id INTO v_wh
    FROM public.warehouses WHERE id = p_warehouse_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Warehouse not found');
  END IF;

  IF v_wh.organization_id IS DISTINCT FROM p_organization_id THEN
    RETURN jsonb_build_object('success', false, 'error',
      'Warehouse belongs to a different workspace');
  END IF;

  SELECT reserved_quantity INTO v_current_reserved
    FROM warehouse_stock
   WHERE organization_id = p_organization_id
     AND business_id     = v_wh.business_id
     AND product_id      = p_product_id
     AND warehouse_id    = p_warehouse_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'No stock record found');
  END IF;

  IF COALESCE(v_current_reserved, 0) < p_quantity THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', format('Reservation drift: requested %s but only %s reserved',
                      p_quantity, COALESCE(v_current_reserved, 0)),
      'requested', p_quantity,
      'reserved', COALESCE(v_current_reserved, 0)
    );
  END IF;

  UPDATE warehouse_stock
     SET reserved_quantity = COALESCE(reserved_quantity, 0) - p_quantity,
         updated_at = now()
   WHERE organization_id = p_organization_id
     AND product_id      = p_product_id
     AND warehouse_id    = p_warehouse_id;

  RETURN jsonb_build_object('success', true, 'released', p_quantity);
END;
$$;

CREATE OR REPLACE FUNCTION public.apply_physical_count_atomic(
  p_organization_id uuid,
  p_business_id uuid,
  p_warehouse_id uuid,
  p_user_id uuid,
  p_lines jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_adj_id uuid;
  v_line jsonb;
  v_total_positive numeric := 0;
  v_total_negative numeric := 0;
  v_inventory_account_id uuid;
  v_adjustment_account_id uuid;
  v_journal_id uuid;
  v_entry_number text;
  v_count int := 0;
  v_cost numeric;
  v_branch_id uuid;
  v_line_warehouse uuid;
  v_line_branch uuid;
BEGIN
  IF p_warehouse_id IS NULL THEN
    RAISE EXCEPTION 'apply_physical_count_atomic requires p_warehouse_id';
  END IF;
  SELECT branch_id INTO v_branch_id FROM public.warehouses WHERE id = p_warehouse_id;

  INSERT INTO stock_adjustments (
    organization_id, business_id, branch_id, warehouse_id,
    adjustment_number, adjustment_date, reason, notes, status,
    approved_by, approved_at, created_by, allow_negative
  ) VALUES (
    p_organization_id, p_business_id, v_branch_id, p_warehouse_id,
    'COUNT-' || UPPER(TO_HEX(EXTRACT(EPOCH FROM now())::bigint)),
    CURRENT_DATE,
    'Physical Count',
    'Physical inventory count — atomic',
    'approved', p_user_id, now(), p_user_id,
    true
  ) RETURNING id INTO v_adj_id;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines)
  LOOP
    v_count := v_count + 1;

    v_line_warehouse := COALESCE((v_line->>'warehouse_id')::uuid, p_warehouse_id);
    SELECT branch_id INTO v_line_branch FROM public.warehouses WHERE id = v_line_warehouse;

    INSERT INTO stock_adjustment_items (
      adjustment_id, product_id, quantity_before, quantity_adjustment,
      quantity_after, unit_cost, warehouse_id, notes
    ) VALUES (
      v_adj_id,
      (v_line->>'product_id')::uuid,
      (v_line->>'system_qty')::numeric,
      (v_line->>'variance')::numeric,
      (v_line->>'system_qty')::numeric + (v_line->>'variance')::numeric,
      (v_line->>'cost_price')::numeric,
      v_line_warehouse,
      'System: ' || (v_line->>'system_qty') || ', Counted: ' || (v_line->>'counted_qty')
    );

    INSERT INTO stock_movements (
      organization_id, business_id, branch_id, product_id, warehouse_id,
      movement_type, quantity, unit_cost,
      reference_type, reference_id, notes, created_by
    ) VALUES (
      p_organization_id, p_business_id, v_line_branch,
      (v_line->>'product_id')::uuid, v_line_warehouse,
      'count', (v_line->>'variance')::numeric, (v_line->>'cost_price')::numeric,
      'stock_adjustment', v_adj_id,
      'Physical count adjustment. System: ' || (v_line->>'system_qty') || ', Counted: ' || (v_line->>'counted_qty'),
      p_user_id
    );

    v_cost := ABS((v_line->>'variance')::numeric) * COALESCE((v_line->>'cost_price')::numeric, 0);
    IF v_cost > 0 THEN
      IF (v_line->>'variance')::numeric > 0 THEN
        v_total_positive := v_total_positive + v_cost;
      ELSE
        v_total_negative := v_total_negative + v_cost;
      END IF;
    END IF;
  END LOOP;

  v_inventory_account_id  := public.resolve_default_account(p_business_id, 'inventory');
  v_adjustment_account_id := public.resolve_default_account(p_business_id, 'inventory_adjustment');

  IF v_inventory_account_id IS NOT NULL AND v_adjustment_account_id IS NOT NULL
     AND (v_total_positive > 0 OR v_total_negative > 0) THEN

    SELECT 'JE-' || LPAD((COALESCE(MAX(CAST(SUBSTRING(entry_number FROM 4) AS integer)), 0) + 1)::text, 5, '0')
      INTO v_entry_number
      FROM journal_entries WHERE organization_id = p_organization_id;

    INSERT INTO journal_entries (
      organization_id, business_id, branch_id, entry_number, entry_date,
      description, reference, source_type, source_id,
      status, posted_at, posted_by, created_by
    ) VALUES (
      p_organization_id, p_business_id, v_branch_id, v_entry_number, CURRENT_DATE,
      'Physical count — ' || v_count || ' adjustments',
      'COUNT-' || LEFT(v_adj_id::text, 8),
      'physical_count', v_adj_id,
      'posted', now(), p_user_id, p_user_id
    ) RETURNING id INTO v_journal_id;

    IF v_total_positive > 0 THEN
      INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description, business_id, branch_id)
      VALUES
        (v_journal_id, v_inventory_account_id, v_total_positive, 0, 'Physical count — inventory surplus', p_business_id, v_branch_id),
        (v_journal_id, v_adjustment_account_id, 0, v_total_positive, 'Physical count — surplus offset', p_business_id, v_branch_id);
    END IF;

    IF v_total_negative > 0 THEN
      INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description, business_id, branch_id)
      VALUES
        (v_journal_id, v_adjustment_account_id, v_total_negative, 0, 'Physical count — inventory shrinkage', p_business_id, v_branch_id),
        (v_journal_id, v_inventory_account_id, 0, v_total_negative, 'Physical count — shrinkage reduction', p_business_id, v_branch_id);
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'adjustment_id', v_adj_id,
    'lines_processed', v_count,
    'gl_posted', v_journal_id IS NOT NULL
  );
END;
$$;

-- =============================================================
-- PHASE 3: CANCEL-TRANSFER ATTRIBUTION
-- =============================================================

CREATE OR REPLACE FUNCTION public.cancel_stock_transfer_atomic(
  p_transfer_id uuid,
  p_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_transfer RECORD;
  v_item RECORD;
  v_in_transit_wh uuid;
  v_dispatched numeric;
  v_received numeric;
  v_remaining_in_transit numeric;
BEGIN
  SELECT * INTO v_transfer FROM public.stock_transfers
   WHERE id = p_transfer_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Transfer not found');
  END IF;

  IF v_transfer.status NOT IN ('draft', 'pending', 'approved') THEN
    RETURN jsonb_build_object('success', false, 'error',
      'Only draft, pending, or approved transfers can be cancelled. Current: ' || v_transfer.status);
  END IF;

  IF v_transfer.status = 'approved' THEN
    v_in_transit_wh := public.get_or_create_in_transit_warehouse(v_transfer.business_id);

    FOR v_item IN
      SELECT product_id, quantity_requested
        FROM public.stock_transfer_items
       WHERE transfer_id = p_transfer_id
         AND quantity_requested > 0
    LOOP
      SELECT COALESCE(SUM(quantity), 0) INTO v_dispatched
        FROM public.stock_movements
       WHERE reference_type = 'stock_transfer'
         AND reference_id = p_transfer_id
         AND warehouse_id = v_in_transit_wh
         AND product_id = v_item.product_id
         AND branch_id = v_transfer.from_branch_id
         AND quantity > 0;

      SELECT COALESCE(SUM(-quantity), 0) INTO v_received
        FROM public.stock_movements
       WHERE reference_type = 'stock_transfer'
         AND reference_id = p_transfer_id
         AND warehouse_id = v_in_transit_wh
         AND product_id = v_item.product_id
         AND branch_id = v_transfer.to_branch_id
         AND quantity < 0;

      v_remaining_in_transit := v_dispatched - v_received;

      IF v_remaining_in_transit <= 0 THEN
        CONTINUE;
      END IF;

      INSERT INTO public.stock_movements (
        organization_id, business_id, branch_id, product_id, warehouse_id,
        movement_type, quantity, reference_type, reference_id, notes, created_by
      ) VALUES (
        v_transfer.organization_id, v_transfer.business_id, v_transfer.from_branch_id,
        v_item.product_id, v_in_transit_wh,
        'transfer', -v_remaining_in_transit,
        'stock_transfer', p_transfer_id,
        'Cancel: out of transit (' || v_transfer.transfer_number || ')',
        p_user_id
      );

      INSERT INTO public.stock_movements (
        organization_id, business_id, branch_id, product_id, warehouse_id,
        movement_type, quantity, reference_type, reference_id, notes, created_by
      ) VALUES (
        v_transfer.organization_id, v_transfer.business_id, v_transfer.from_branch_id,
        v_item.product_id, v_transfer.from_warehouse_id,
        'transfer', v_remaining_in_transit,
        'stock_transfer', p_transfer_id,
        'Cancel: return to source (' || v_transfer.transfer_number || ')',
        p_user_id
      );
    END LOOP;
  END IF;

  UPDATE public.stock_transfers
     SET status = 'cancelled', updated_at = NOW()
   WHERE id = p_transfer_id;

  RETURN jsonb_build_object('success', true);
END;
$$;

-- =============================================================
-- 1.6 record_opening_stock — use default_accounts
-- =============================================================
CREATE OR REPLACE FUNCTION public.record_opening_stock(
  p_business_id uuid,
  p_warehouse_id uuid,
  p_items jsonb,
  p_user_id uuid DEFAULT auth.uid()
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_org_id uuid;
  v_branch_id uuid;
  v_adjustment_id uuid;
  v_item jsonb;
  v_product_id uuid;
  v_quantity numeric;
  v_unit_cost numeric;
  v_total_value numeric := 0;
  v_inventory_account_id uuid;
  v_opening_equity_account_id uuid;
  v_je_id uuid;
  v_adjustment_number text;
  v_count integer := 0;
BEGIN
  IF p_business_id IS NULL OR p_warehouse_id IS NULL OR p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'business_id, warehouse_id, and non-empty items are required';
  END IF;

  SELECT organization_id, branch_id
    INTO v_org_id, v_branch_id
    FROM warehouses
   WHERE id = p_warehouse_id AND business_id = p_business_id AND is_active = true;

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'Warehouse % not found in business %', p_warehouse_id, p_business_id;
  END IF;

  v_inventory_account_id      := public.resolve_default_account(p_business_id, 'inventory');
  v_opening_equity_account_id := public.resolve_default_account(p_business_id, 'opening_equity');

  IF v_inventory_account_id IS NULL THEN
    RAISE EXCEPTION 'Inventory asset account not found in chart of accounts for this company';
  END IF;
  IF v_opening_equity_account_id IS NULL THEN
    RAISE EXCEPTION 'Opening Balance / Equity account not found in chart of accounts for this company';
  END IF;

  v_adjustment_number := 'OPEN-' || to_char(now(), 'YYYYMMDD-HH24MISS');

  INSERT INTO stock_adjustments (
    organization_id, business_id, branch_id, warehouse_id,
    adjustment_number, reason, status, notes, created_by, adjustment_date,
    allow_negative
  ) VALUES (
    v_org_id, p_business_id, v_branch_id, p_warehouse_id,
    v_adjustment_number, 'opening_balance', 'approved',
    'Opening balance entry', p_user_id, now(),
    true
  ) RETURNING id INTO v_adjustment_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_product_id := (v_item->>'product_id')::uuid;
    v_quantity   := COALESCE((v_item->>'quantity')::numeric, 0);
    v_unit_cost  := COALESCE((v_item->>'unit_cost')::numeric, 0);

    IF v_quantity <= 0 THEN CONTINUE; END IF;

    INSERT INTO stock_adjustment_items (
      adjustment_id, product_id, system_quantity, counted_quantity,
      adjustment_quantity, unit_cost
    ) VALUES (
      v_adjustment_id, v_product_id, 0, v_quantity, v_quantity, v_unit_cost
    );

    INSERT INTO stock_movements (
      organization_id, business_id, branch_id, warehouse_id,
      product_id, movement_type, quantity, unit_cost, total_cost,
      reference_type, reference_id, notes, created_by
    ) VALUES (
      v_org_id, p_business_id, v_branch_id, p_warehouse_id,
      v_product_id, 'opening', v_quantity, v_unit_cost, v_quantity * v_unit_cost,
      'stock_adjustment', v_adjustment_id, 'Opening balance', p_user_id
    );

    v_total_value := v_total_value + (v_quantity * v_unit_cost);
    v_count := v_count + 1;
  END LOOP;

  IF v_total_value > 0 THEN
    INSERT INTO journal_entries (
      organization_id, business_id, branch_id, entry_number, entry_date,
      description, status, source_type, source_id, created_by
    ) VALUES (
      v_org_id, p_business_id, v_branch_id,
      'JE-' || v_adjustment_number,
      CURRENT_DATE,
      'Opening stock balance — ' || v_adjustment_number,
      'posted', 'stock_adjustment', v_adjustment_id, p_user_id
    ) RETURNING id INTO v_je_id;

    INSERT INTO journal_entry_lines (
      journal_entry_id, account_id, debit, credit, description,
      business_id, branch_id
    ) VALUES
      (v_je_id, v_inventory_account_id, v_total_value, 0, 'Opening inventory', p_business_id, v_branch_id),
      (v_je_id, v_opening_equity_account_id, 0, v_total_value, 'Opening balance equity', p_business_id, v_branch_id);
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'adjustment_id', v_adjustment_id,
    'adjustment_number', v_adjustment_number,
    'item_count', v_count,
    'total_value', v_total_value,
    'journal_entry_id', v_je_id
  );
END;
$$;
