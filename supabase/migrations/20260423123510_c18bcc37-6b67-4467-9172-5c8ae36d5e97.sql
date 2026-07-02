-- =========================================================================
-- 1. recurring_invoices: ensure branch_id exists
-- =========================================================================
ALTER TABLE public.recurring_invoices
  ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_recurring_invoices_branch ON public.recurring_invoices(branch_id);

-- Enforce branch×business match on recurring_invoices
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'enforce_branch_business_match_recurring_invoices'
  ) AND EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'enforce_branch_business_match'
  ) THEN
    EXECUTE 'CREATE TRIGGER enforce_branch_business_match_recurring_invoices
             BEFORE INSERT OR UPDATE ON public.recurring_invoices
             FOR EACH ROW EXECUTE FUNCTION public.enforce_branch_business_match()';
  END IF;
END $$;

-- =========================================================================
-- 2. invoices.source_proforma_invoice_id + business-match trigger
-- =========================================================================
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS source_proforma_invoice_id uuid
    REFERENCES public.proforma_invoices(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_invoices_source_proforma ON public.invoices(source_proforma_invoice_id);

CREATE OR REPLACE FUNCTION public.enforce_invoice_proforma_business_match()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_proforma_business uuid;
BEGIN
  IF NEW.source_proforma_invoice_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT business_id INTO v_proforma_business
  FROM public.proforma_invoices
  WHERE id = NEW.source_proforma_invoice_id;
  IF v_proforma_business IS NOT NULL AND v_proforma_business <> NEW.business_id THEN
    RAISE EXCEPTION 'Invoice business_id (%) does not match source proforma invoice business_id (%)',
      NEW.business_id, v_proforma_business
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_invoice_proforma_business_match ON public.invoices;
CREATE TRIGGER enforce_invoice_proforma_business_match
  BEFORE INSERT OR UPDATE OF source_proforma_invoice_id, business_id ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.enforce_invoice_proforma_business_match();

-- =========================================================================
-- 3. invoices.source_estimate_id business-match trigger
--    (column already exists per audit; only add the trigger if missing)
-- =========================================================================
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='invoices' AND column_name='source_estimate_id'
  ) THEN
    EXECUTE $f$
      CREATE OR REPLACE FUNCTION public.enforce_invoice_estimate_business_match()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = public
      AS $body$
      DECLARE
        v_estimate_business uuid;
      BEGIN
        IF NEW.source_estimate_id IS NULL THEN
          RETURN NEW;
        END IF;
        SELECT business_id INTO v_estimate_business
        FROM public.estimates
        WHERE id = NEW.source_estimate_id;
        IF v_estimate_business IS NOT NULL AND v_estimate_business <> NEW.business_id THEN
          RAISE EXCEPTION 'Invoice business_id (%) does not match source estimate business_id (%)',
            NEW.business_id, v_estimate_business
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END;
      $body$;
    $f$;
    DROP TRIGGER IF EXISTS enforce_invoice_estimate_business_match ON public.invoices;
    CREATE TRIGGER enforce_invoice_estimate_business_match
      BEFORE INSERT OR UPDATE OF source_estimate_id, business_id ON public.invoices
      FOR EACH ROW EXECUTE FUNCTION public.enforce_invoice_estimate_business_match();
  END IF;
END $$;

-- =========================================================================
-- 4. credit_note_status enum: add 'refunded'
-- =========================================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'credit_note_status') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_enum
      WHERE enumtypid = 'public.credit_note_status'::regtype
        AND enumlabel = 'refunded'
    ) THEN
      ALTER TYPE public.credit_note_status ADD VALUE 'refunded';
    END IF;
  END IF;
END $$;

-- =========================================================================
-- 5. Replace legacy RLS policies on delivery_notes and estimates with
--    business-aware (4-arg) variants. Drops any policy whose name suggests
--    the legacy *_perm pattern; recreates clean v2 policies.
-- =========================================================================
DO $$
DECLARE
  pol record;
BEGIN
  FOR pol IN
    SELECT policyname
    FROM pg_policies
    WHERE schemaname='public' AND tablename='delivery_notes'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.delivery_notes', pol.policyname);
  END LOOP;

  FOR pol IN
    SELECT policyname
    FROM pg_policies
    WHERE schemaname='public' AND tablename='estimates'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.estimates', pol.policyname);
  END LOOP;
END $$;

ALTER TABLE public.delivery_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.estimates      ENABLE ROW LEVEL SECURITY;

-- delivery_notes
CREATE POLICY delivery_notes_select_v2 ON public.delivery_notes
  FOR SELECT TO authenticated
  USING (
    public.user_can_access_business(auth.uid(), business_id)
    AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'sales', 'view')
  );

CREATE POLICY delivery_notes_insert_v2 ON public.delivery_notes
  FOR INSERT TO authenticated
  WITH CHECK (
    public.user_can_access_business(auth.uid(), business_id)
    AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'sales', 'manage')
  );

CREATE POLICY delivery_notes_update_v2 ON public.delivery_notes
  FOR UPDATE TO authenticated
  USING (
    public.user_can_access_business(auth.uid(), business_id)
    AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'sales', 'manage')
  )
  WITH CHECK (
    public.user_can_access_business(auth.uid(), business_id)
    AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'sales', 'manage')
  );

CREATE POLICY delivery_notes_delete_v2 ON public.delivery_notes
  FOR DELETE TO authenticated
  USING (
    public.user_can_access_business(auth.uid(), business_id)
    AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'sales', 'manage')
  );

-- estimates
CREATE POLICY estimates_select_v2 ON public.estimates
  FOR SELECT TO authenticated
  USING (
    public.user_can_access_business(auth.uid(), business_id)
    AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'sales', 'view')
  );

CREATE POLICY estimates_insert_v2 ON public.estimates
  FOR INSERT TO authenticated
  WITH CHECK (
    public.user_can_access_business(auth.uid(), business_id)
    AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'sales', 'manage')
  );

CREATE POLICY estimates_update_v2 ON public.estimates
  FOR UPDATE TO authenticated
  USING (
    public.user_can_access_business(auth.uid(), business_id)
    AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'sales', 'manage')
  )
  WITH CHECK (
    public.user_can_access_business(auth.uid(), business_id)
    AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'sales', 'manage')
  );

CREATE POLICY estimates_delete_v2 ON public.estimates
  FOR DELETE TO authenticated
  USING (
    public.user_can_access_business(auth.uid(), business_id)
    AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'sales', 'manage')
  );

-- =========================================================================
-- 6. Extend get_sales_dashboard_kpis to accept p_branch_id.
--    Implemented as a NEW overload so existing 4-arg callers keep working.
-- =========================================================================
CREATE OR REPLACE FUNCTION public.get_sales_dashboard_kpis(
  p_org_id uuid,
  p_business_id uuid,
  p_branch_id uuid,
  p_date_from date,
  p_date_to date
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total_revenue numeric := 0;
  v_outstanding numeric := 0;
  v_overdue numeric := 0;
  v_paid_count integer := 0;
  v_total_count integer := 0;
  v_draft_count integer := 0;
  v_avg_invoice numeric := 0;
BEGIN
  SELECT
    COALESCE(SUM(CASE WHEN status IN ('paid','partial','sent','viewed','overdue','confirmed') THEN total ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN status IN ('sent','viewed','partial','overdue','confirmed') THEN GREATEST(total - COALESCE(amount_paid,0),0) ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN status='overdue' OR (status IN ('sent','viewed','partial','confirmed') AND due_date < CURRENT_DATE) THEN GREATEST(total - COALESCE(amount_paid,0),0) ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN status='paid' THEN 1 ELSE 0 END), 0),
    COUNT(*),
    COALESCE(SUM(CASE WHEN status='draft' THEN 1 ELSE 0 END), 0)
  INTO v_total_revenue, v_outstanding, v_overdue, v_paid_count, v_total_count, v_draft_count
  FROM public.invoices
  WHERE organization_id = p_org_id
    AND business_id = p_business_id
    AND issue_date BETWEEN p_date_from AND p_date_to
    AND (p_branch_id IS NULL OR branch_id = p_branch_id OR branch_id IS NULL);

  IF v_total_count > 0 THEN
    v_avg_invoice := v_total_revenue / v_total_count;
  END IF;

  RETURN jsonb_build_object(
    'total_revenue', v_total_revenue,
    'outstanding', v_outstanding,
    'overdue', v_overdue,
    'paid_count', v_paid_count,
    'total_count', v_total_count,
    'draft_count', v_draft_count,
    'avg_invoice', v_avg_invoice
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_sales_dashboard_kpis(uuid, uuid, uuid, date, date) TO authenticated;

-- =========================================================================
-- 7. approve_sales_return_atomic: wrap CN insert + items + stock + status flip
-- =========================================================================
CREATE OR REPLACE FUNCTION public.approve_sales_return_atomic(
  p_return_id uuid,
  p_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_return RECORD;
  v_cn_number text;
  v_cn_id uuid;
  v_warehouse_id uuid;
  v_item RECORD;
  v_inventory_count integer := 0;
BEGIN
  SELECT * INTO v_return
  FROM public.sales_returns
  WHERE id = p_return_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sales return % not found', p_return_id;
  END IF;
  IF v_return.status <> 'pending' THEN
    RAISE EXCEPTION 'Only pending sales returns can be approved (current: %)', v_return.status;
  END IF;

  IF NOT public.user_can_access_business(p_user_id, v_return.business_id) THEN
    RAISE EXCEPTION 'Access denied for business %', v_return.business_id;
  END IF;

  SELECT public.get_next_credit_note_number(v_return.organization_id) INTO v_cn_number;

  INSERT INTO public.credit_notes(
    organization_id, business_id, branch_id,
    credit_note_number, contact_id, invoice_id, issue_date, status,
    reason, subtotal, tax_amount, total, currency, notes,
    created_by, source_return_id
  ) VALUES (
    v_return.organization_id,
    v_return.business_id,
    v_return.branch_id,
    v_cn_number,
    v_return.contact_id,
    v_return.invoice_id,
    CURRENT_DATE,
    'draft',
    v_return.reason,
    v_return.subtotal,
    v_return.tax_amount,
    v_return.total,
    v_return.currency,
    'Auto-created from Sales Return ' || v_return.return_number,
    p_user_id,
    v_return.id
  )
  RETURNING id INTO v_cn_id;

  INSERT INTO public.credit_note_items(
    credit_note_id, product_id, description, quantity, unit_price,
    tax_rate, tax_amount, line_total, sort_order
  )
  SELECT
    v_cn_id, sri.product_id, sri.description, sri.quantity, sri.unit_price,
    COALESCE(sri.tax_rate,0), COALESCE(sri.tax_amount,0), sri.line_total, sri.sort_order
  FROM public.sales_return_items sri
  WHERE sri.sales_return_id = p_return_id;

  -- Restore stock for inventory items
  SELECT COUNT(*) INTO v_inventory_count
  FROM public.sales_return_items sri
  WHERE sri.sales_return_id = p_return_id AND sri.product_id IS NOT NULL;

  IF v_inventory_count > 0 THEN
    SELECT id INTO v_warehouse_id
    FROM public.warehouses
    WHERE organization_id = v_return.organization_id
      AND business_id = v_return.business_id
      AND is_default = true
      AND is_active = true
    LIMIT 1;

    IF v_warehouse_id IS NULL THEN
      RAISE EXCEPTION 'No default warehouse configured for this company — cannot restore stock';
    END IF;

    FOR v_item IN
      SELECT product_id, quantity
      FROM public.sales_return_items
      WHERE sales_return_id = p_return_id AND product_id IS NOT NULL
    LOOP
      INSERT INTO public.stock_movements(
        organization_id, business_id, product_id, movement_type,
        quantity, reference_type, reference_id, warehouse_id, notes
      ) VALUES (
        v_return.organization_id,
        v_return.business_id,
        v_item.product_id,
        'return_in',
        v_item.quantity,
        'sales_return',
        p_return_id,
        v_warehouse_id,
        'Sales return ' || v_return.return_number || ' approved - stock restored'
      );
    END LOOP;
  END IF;

  UPDATE public.sales_returns
  SET status = 'approved',
      credit_note_id = v_cn_id,
      updated_at = now()
  WHERE id = p_return_id;

  RETURN jsonb_build_object(
    'success', true,
    'credit_note_id', v_cn_id,
    'credit_note_number', v_cn_number
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.approve_sales_return_atomic(uuid, uuid) TO authenticated;

-- =========================================================================
-- 8. convert_so_to_invoice_atomic: invoice insert + items + SO flip in one txn
-- =========================================================================
CREATE OR REPLACE FUNCTION public.convert_so_to_invoice_atomic(
  p_so_id uuid,
  p_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_so RECORD;
  v_inv_number text;
  v_inv_id uuid;
BEGIN
  SELECT * INTO v_so
  FROM public.sales_orders
  WHERE id = p_so_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sales order % not found', p_so_id;
  END IF;
  IF v_so.converted_invoice_id IS NOT NULL THEN
    RAISE EXCEPTION 'Sales order % already converted to invoice %', v_so.so_number, v_so.converted_invoice_id;
  END IF;
  IF v_so.status NOT IN ('confirmed','processing','partial','fulfilled') THEN
    RAISE EXCEPTION 'Cannot convert sales order in status % — must be confirmed first', v_so.status;
  END IF;
  IF NOT public.user_can_access_business(p_user_id, v_so.business_id) THEN
    RAISE EXCEPTION 'Access denied for business %', v_so.business_id;
  END IF;

  SELECT public.get_next_invoice_number(v_so.organization_id, v_so.business_id) INTO v_inv_number;

  INSERT INTO public.invoices(
    organization_id, business_id, branch_id, contact_id,
    invoice_number, status, issue_date, due_date,
    subtotal, tax_amount, discount_amount, total, currency,
    notes, created_by, salesperson_id, payment_term_id,
    source_sales_order_id
  ) VALUES (
    v_so.organization_id, v_so.business_id, v_so.branch_id, v_so.contact_id,
    v_inv_number, 'draft', CURRENT_DATE, CURRENT_DATE + INTERVAL '30 days',
    v_so.subtotal, v_so.tax_amount, v_so.discount_amount, v_so.total, v_so.currency,
    v_so.notes, p_user_id, COALESCE(v_so.salesperson_id, p_user_id), v_so.payment_term_id,
    p_so_id
  )
  RETURNING id INTO v_inv_id;

  INSERT INTO public.invoice_items(
    invoice_id, product_id, description, quantity, unit_price,
    tax_rate, tax_amount, discount_percent, line_total, sort_order
  )
  SELECT
    v_inv_id, soi.product_id, soi.description, soi.quantity, soi.unit_price,
    COALESCE(soi.tax_rate,0), COALESCE(soi.tax_amount,0),
    COALESCE(soi.discount_percent,0), soi.line_total, soi.sort_order
  FROM public.sales_order_items soi
  WHERE soi.sales_order_id = p_so_id;

  UPDATE public.sales_orders
  SET status = 'invoiced',
      converted_invoice_id = v_inv_id,
      converted_at = now(),
      updated_at = now()
  WHERE id = p_so_id;

  RETURN jsonb_build_object(
    'success', true,
    'invoice_id', v_inv_id,
    'invoice_number', v_inv_number
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.convert_so_to_invoice_atomic(uuid, uuid) TO authenticated;

-- =========================================================================
-- 9. convert_estimate_to_invoice_atomic: same pattern for estimates
-- =========================================================================
CREATE OR REPLACE FUNCTION public.convert_estimate_to_invoice_atomic(
  p_estimate_id uuid,
  p_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_est RECORD;
  v_inv_number text;
  v_inv_id uuid;
BEGIN
  SELECT * INTO v_est
  FROM public.estimates
  WHERE id = p_estimate_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Estimate % not found', p_estimate_id;
  END IF;
  IF v_est.converted_invoice_id IS NOT NULL THEN
    RAISE EXCEPTION 'Estimate % already converted to invoice %', v_est.estimate_number, v_est.converted_invoice_id;
  END IF;
  IF v_est.status NOT IN ('draft','sent','accepted','approved') THEN
    RAISE EXCEPTION 'Cannot convert estimate in status %', v_est.status;
  END IF;
  IF NOT public.user_can_access_business(p_user_id, v_est.business_id) THEN
    RAISE EXCEPTION 'Access denied for business %', v_est.business_id;
  END IF;

  SELECT public.get_next_invoice_number(v_est.organization_id, v_est.business_id) INTO v_inv_number;

  INSERT INTO public.invoices(
    organization_id, business_id, branch_id, contact_id,
    invoice_number, status, issue_date, due_date,
    subtotal, tax_amount, discount_amount, total, currency,
    notes, terms, created_by,
    source_estimate_id
  ) VALUES (
    v_est.organization_id, v_est.business_id, v_est.branch_id, v_est.contact_id,
    v_inv_number, 'draft', CURRENT_DATE, CURRENT_DATE + INTERVAL '30 days',
    v_est.subtotal, v_est.tax_amount, COALESCE(v_est.discount_amount,0), v_est.total, v_est.currency,
    v_est.notes, v_est.terms, p_user_id,
    p_estimate_id
  )
  RETURNING id INTO v_inv_id;

  INSERT INTO public.invoice_items(
    invoice_id, product_id, description, quantity, unit_price,
    tax_rate, tax_amount, discount_percent, line_total, sort_order
  )
  SELECT
    v_inv_id, ei.product_id, ei.description, ei.quantity, ei.unit_price,
    COALESCE(ei.tax_rate,0), COALESCE(ei.tax_amount,0),
    COALESCE(ei.discount_percent,0), ei.line_total, ei.sort_order
  FROM public.estimate_items ei
  WHERE ei.estimate_id = p_estimate_id;

  UPDATE public.estimates
  SET status = 'converted',
      converted_invoice_id = v_inv_id,
      converted_at = now(),
      updated_at = now()
  WHERE id = p_estimate_id;

  RETURN jsonb_build_object(
    'success', true,
    'invoice_id', v_inv_id,
    'invoice_number', v_inv_number
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.convert_estimate_to_invoice_atomic(uuid, uuid) TO authenticated;