-- ============================================================
-- Phase 0: unbreak conversions
-- ============================================================
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS source_estimate_id uuid REFERENCES public.estimates(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_invoices_source_estimate_id ON public.invoices(source_estimate_id);

-- Phase 1: lifecycle columns
ALTER TABLE public.estimates
  ADD COLUMN IF NOT EXISTS sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS viewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS accepted_at timestamptz,
  ADD COLUMN IF NOT EXISTS rejected_at timestamptz,
  ADD COLUMN IF NOT EXISTS converted_sales_order_id uuid REFERENCES public.sales_orders(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_estimates_converted_so ON public.estimates(converted_sales_order_id);

-- Status history
CREATE TABLE IF NOT EXISTS public.estimate_status_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  estimate_id uuid NOT NULL REFERENCES public.estimates(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL,
  business_id uuid,
  from_status text,
  to_status text NOT NULL,
  reason text,
  changed_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.estimate_status_events TO authenticated;
GRANT ALL ON public.estimate_status_events TO service_role;
ALTER TABLE public.estimate_status_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS estimate_status_events_select ON public.estimate_status_events;
CREATE POLICY estimate_status_events_select ON public.estimate_status_events
FOR SELECT TO authenticated
USING (
  public.user_can_access_business(auth.uid(), business_id)
  AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'sales', 'view')
);
CREATE INDEX IF NOT EXISTS idx_estimate_status_events_estimate ON public.estimate_status_events(estimate_id, created_at DESC);

-- ============================================================
-- Status writer guard
-- ============================================================
CREATE OR REPLACE FUNCTION public._estimate_status_write_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     AND COALESCE(current_setting('app.estimate_status_writer', true), '') <> '1' THEN
    RAISE EXCEPTION 'Estimate status must be changed through set_estimate_status_atomic()'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_estimate_status_write_guard ON public.estimates;
CREATE TRIGGER trg_estimate_status_write_guard
BEFORE UPDATE ON public.estimates
FOR EACH ROW EXECUTE FUNCTION public._estimate_status_write_guard();

-- ============================================================
-- State machine
-- ============================================================
CREATE OR REPLACE FUNCTION public.set_estimate_status_atomic(
  p_estimate_id uuid,
  p_status text,
  p_user_id uuid DEFAULT NULL,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_est RECORD;
  v_user uuid := COALESCE(p_user_id, auth.uid());
  v_allowed text[];
BEGIN
  SELECT * INTO v_est FROM public.estimates WHERE id = p_estimate_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Estimate % not found', p_estimate_id;
  END IF;

  IF v_user IS NULL OR NOT public.user_can_access_business(v_user, v_est.business_id) THEN
    RAISE EXCEPTION 'Access denied for business %', v_est.business_id USING ERRCODE = '42501';
  END IF;

  IF v_est.status = p_status THEN
    RETURN jsonb_build_object('success', true, 'status', p_status, 'unchanged', true);
  END IF;

  v_allowed := CASE v_est.status
    WHEN 'draft'     THEN ARRAY['sent','rejected','expired']
    WHEN 'sent'      THEN ARRAY['viewed','accepted','rejected','expired']
    WHEN 'viewed'    THEN ARRAY['accepted','rejected','expired']
    WHEN 'accepted'  THEN ARRAY['converted','rejected','expired']
    WHEN 'expired'   THEN ARRAY['sent']
    ELSE ARRAY[]::text[]
  END;

  IF NOT (p_status = ANY (v_allowed)) THEN
    RAISE EXCEPTION 'Illegal estimate transition % -> %', v_est.status, p_status
      USING ERRCODE = '22023';
  END IF;

  PERFORM set_config('app.estimate_status_writer', '1', true);

  UPDATE public.estimates
  SET status      = p_status,
      sent_at     = CASE WHEN p_status = 'sent'     THEN now() ELSE sent_at END,
      viewed_at   = CASE WHEN p_status = 'viewed'   THEN now() ELSE viewed_at END,
      accepted_at = CASE WHEN p_status = 'accepted' THEN now() ELSE accepted_at END,
      rejected_at = CASE WHEN p_status = 'rejected' THEN now() ELSE rejected_at END,
      updated_at  = now()
  WHERE id = p_estimate_id;

  PERFORM set_config('app.estimate_status_writer', '0', true);

  INSERT INTO public.estimate_status_events(
    estimate_id, organization_id, business_id, from_status, to_status, reason, changed_by
  ) VALUES (
    p_estimate_id, v_est.organization_id, v_est.business_id, v_est.status, p_status, p_reason, v_user
  );

  RETURN jsonb_build_object('success', true, 'status', p_status, 'from_status', v_est.status);
END;
$$;
GRANT EXECUTE ON FUNCTION public.set_estimate_status_atomic(uuid, text, uuid, text) TO authenticated;

-- Expiry sweeper
CREATE OR REPLACE FUNCTION public.expire_stale_estimates()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  r RECORD;
  v_count integer := 0;
BEGIN
  FOR r IN
    SELECT id, organization_id, business_id, status
    FROM public.estimates
    WHERE status IN ('sent','viewed')
      AND expiry_date IS NOT NULL
      AND expiry_date < CURRENT_DATE
    FOR UPDATE SKIP LOCKED
  LOOP
    PERFORM set_config('app.estimate_status_writer', '1', true);
    UPDATE public.estimates SET status = 'expired', updated_at = now() WHERE id = r.id;
    PERFORM set_config('app.estimate_status_writer', '0', true);

    INSERT INTO public.estimate_status_events(
      estimate_id, organization_id, business_id, from_status, to_status, reason
    ) VALUES (r.id, r.organization_id, r.business_id, r.status, 'expired', 'auto-expiry: past expiry_date');

    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;

-- ============================================================
-- Phase 2: numbering convergence
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_next_estimate_number(_org_id uuid, _business_id uuid DEFAULT NULL::uuid, _branch_id uuid DEFAULT NULL::uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  next_num integer;
  year_prefix text;
  prefix text := 'EST';
  v_cfg jsonb;
BEGIN
  year_prefix := to_char(CURRENT_DATE, 'YYYY');

  IF _business_id IS NOT NULL AND _branch_id IS NOT NULL THEN
    v_cfg := public.get_effective_company_config(_business_id, _branch_id);
    prefix := COALESCE(NULLIF(v_cfg->'estimate_prefix'->>'value', ''), 'EST');
  ELSIF _business_id IS NOT NULL THEN
    SELECT COALESCE(estimate_prefix, 'EST') INTO prefix
    FROM public.businesses WHERE id = _business_id;
  ELSE
    SELECT COALESCE(estimate_prefix, 'EST') INTO prefix
    FROM public.businesses WHERE organization_id = _org_id LIMIT 1;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('estimates_' || _org_id::text || '_' || COALESCE(_branch_id::text, 'global')));

  -- Parse ONLY the trailing counter segment, never the whole string
  -- (stripping all non-digits would fold the year into the counter).
  SELECT COALESCE(MAX(
    CAST(NULLIF(regexp_replace(split_part(estimate_number, '-', 3), '[^0-9]', '', 'g'), '') AS INTEGER)
  ), 0) + 1 INTO next_num
  FROM public.estimates
  WHERE organization_id = _org_id
    AND (_business_id IS NULL OR business_id = _business_id)
    AND (_branch_id IS NULL OR branch_id = _branch_id)
    AND estimate_number LIKE prefix || '-' || year_prefix || '-%';

  RETURN prefix || '-' || year_prefix || '-' || LPAD(next_num::text, 4, '0');
END;
$$;

CREATE OR REPLACE FUNCTION public.get_next_so_number(_org_id uuid, _business_id uuid, _branch_id uuid DEFAULT NULL::uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  next_num integer;
  year_prefix text;
  prefix text := 'SO';
BEGIN
  year_prefix := to_char(CURRENT_DATE, 'YYYY');

  PERFORM pg_advisory_xact_lock(hashtext('sales_orders_' || _org_id::text || '_' || COALESCE(_branch_id::text, 'global')));

  SELECT COALESCE(MAX(
    CAST(NULLIF(regexp_replace(split_part(so_number, '-', 3), '[^0-9]', '', 'g'), '') AS INTEGER)
  ), 0) + 1 INTO next_num
  FROM public.sales_orders
  WHERE organization_id = _org_id
    AND (_business_id IS NULL OR business_id = _business_id)
    AND (_branch_id IS NULL OR branch_id = _branch_id)
    AND so_number LIKE prefix || '-' || year_prefix || '-%';

  RETURN prefix || '-' || year_prefix || '-' || LPAD(next_num::text, 4, '0');
END;
$$;

-- legacy single-arg signature delegates to the canonical one
CREATE OR REPLACE FUNCTION public.get_next_so_number(_org_id uuid)
RETURNS text
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT public.get_next_so_number(_org_id, NULL::uuid, NULL::uuid);
$$;

-- ============================================================
-- Phase 0 (cont): conversion functions
-- ============================================================
CREATE OR REPLACE FUNCTION public.convert_estimate_to_invoice_atomic(p_estimate_id uuid, p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_est RECORD;
  v_inv_number text;
  v_inv_id uuid;
  v_max_sort integer;
  v_costs numeric := 0;
  v_costs_tax numeric := 0;
  v_subtotal numeric;
BEGIN
  SELECT * INTO v_est FROM public.estimates WHERE id = p_estimate_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Estimate % not found', p_estimate_id;
  END IF;
  IF v_est.converted_invoice_id IS NOT NULL THEN
    RAISE EXCEPTION 'Estimate % already converted to invoice %', v_est.estimate_number, v_est.converted_invoice_id;
  END IF;
  IF v_est.status NOT IN ('draft','sent','viewed','accepted') THEN
    RAISE EXCEPTION 'Cannot convert estimate in status %', v_est.status;
  END IF;
  IF NOT public.user_can_access_business(p_user_id, v_est.business_id) THEN
    RAISE EXCEPTION 'Access denied for business %', v_est.business_id USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(SUM(amount),0), COALESCE(SUM(tax_amount),0)
    INTO v_costs, v_costs_tax
  FROM public.estimate_additional_costs WHERE estimate_id = p_estimate_id;

  v_subtotal := COALESCE(v_est.subtotal,0) + v_costs;

  IF round(v_subtotal + COALESCE(v_est.tax_amount,0) - COALESCE(v_est.discount_amount,0), 2)
     <> round(COALESCE(v_est.total,0), 2) THEN
    RAISE EXCEPTION 'Estimate % totals do not reconcile (subtotal % + tax % - discount % <> total %)',
      v_est.estimate_number, v_subtotal, v_est.tax_amount, v_est.discount_amount, v_est.total;
  END IF;

  SELECT public.get_next_invoice_number(v_est.organization_id, v_est.business_id) INTO v_inv_number;

  INSERT INTO public.invoices(
    organization_id, business_id, branch_id, contact_id,
    invoice_number, status, issue_date, due_date,
    subtotal, tax_amount, discount_amount, total, currency,
    notes, terms, created_by, source_estimate_id
  ) VALUES (
    v_est.organization_id, v_est.business_id, v_est.branch_id, v_est.contact_id,
    v_inv_number, 'draft', CURRENT_DATE, CURRENT_DATE + INTERVAL '30 days',
    v_subtotal, COALESCE(v_est.tax_amount,0), COALESCE(v_est.discount_amount,0), v_est.total, v_est.currency,
    v_est.notes, v_est.terms, p_user_id, p_estimate_id
  )
  RETURNING id INTO v_inv_id;

  INSERT INTO public.invoice_items(
    invoice_id, business_id, product_id, description, quantity, unit_price,
    tax_rate, tax_amount, discount_percent, line_total, sort_order,
    packaging_id, display_uom_id, display_quantity, uom_snapshot
  )
  SELECT
    v_inv_id, v_est.business_id, ei.product_id, ei.description, ei.quantity, ei.unit_price,
    COALESCE(ei.tax_rate,0), COALESCE(ei.tax_amount,0),
    COALESCE(ei.discount_percent,0), ei.line_total, COALESCE(ei.sort_order,0),
    ei.packaging_id, ei.display_uom_id, ei.display_quantity, ei.uom_snapshot
  FROM public.estimate_items ei
  WHERE ei.estimate_id = p_estimate_id;

  SELECT COALESCE(MAX(sort_order), -1) INTO v_max_sort
  FROM public.invoice_items WHERE invoice_id = v_inv_id;

  INSERT INTO public.invoice_items(
    invoice_id, business_id, product_id, description, quantity, unit_price,
    tax_rate, tax_amount, discount_percent, line_total, sort_order
  )
  SELECT
    v_inv_id, v_est.business_id, NULL, ac.name, 1, ac.amount,
    COALESCE(ac.tax_rate,0), COALESCE(ac.tax_amount,0), 0, ac.amount,
    v_max_sort + 1 + row_number() OVER (ORDER BY COALESCE(ac.sort_order,0), ac.created_at)
  FROM public.estimate_additional_costs ac
  WHERE ac.estimate_id = p_estimate_id;

  PERFORM set_config('app.estimate_status_writer', '1', true);
  UPDATE public.estimates
  SET status = 'converted',
      converted_invoice_id = v_inv_id,
      converted_at = now(),
      updated_at = now()
  WHERE id = p_estimate_id;
  PERFORM set_config('app.estimate_status_writer', '0', true);

  INSERT INTO public.estimate_status_events(
    estimate_id, organization_id, business_id, from_status, to_status, reason, changed_by
  ) VALUES (p_estimate_id, v_est.organization_id, v_est.business_id, v_est.status, 'converted',
            'converted to invoice ' || v_inv_number, p_user_id);

  RETURN jsonb_build_object('success', true, 'invoice_id', v_inv_id, 'invoice_number', v_inv_number);
END;
$$;

CREATE OR REPLACE FUNCTION public.convert_estimate_to_so_atomic(p_estimate_id uuid, p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_est RECORD;
  v_so_number text;
  v_so_id uuid;
  v_expected date;
  v_max_sort integer;
  v_costs numeric := 0;
  v_subtotal numeric;
BEGIN
  IF auth.uid() IS NULL AND p_user_id IS NULL THEN
    RAISE EXCEPTION 'auth required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_est FROM public.estimates WHERE id = p_estimate_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Estimate % not found', p_estimate_id;
  END IF;

  IF v_est.status = 'converted' OR v_est.converted_sales_order_id IS NOT NULL THEN
    RAISE EXCEPTION 'Estimate % already converted', v_est.estimate_number;
  END IF;
  IF v_est.status NOT IN ('draft','sent','viewed','accepted') THEN
    RAISE EXCEPTION 'Cannot convert estimate in status %', v_est.status;
  END IF;
  IF v_est.business_id IS NULL OR NOT public.user_can_access_business(p_user_id, v_est.business_id) THEN
    RAISE EXCEPTION 'Access denied for business %', v_est.business_id USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(SUM(amount),0) INTO v_costs
  FROM public.estimate_additional_costs WHERE estimate_id = p_estimate_id;
  v_subtotal := COALESCE(v_est.subtotal,0) + v_costs;

  IF round(v_subtotal + COALESCE(v_est.tax_amount,0) - COALESCE(v_est.discount_amount,0), 2)
     <> round(COALESCE(v_est.total,0), 2) THEN
    RAISE EXCEPTION 'Estimate % totals do not reconcile', v_est.estimate_number;
  END IF;

  SELECT public.get_next_so_number(v_est.organization_id, v_est.business_id, v_est.branch_id) INTO v_so_number;

  -- Honor the customer-facing validity window when present; never schedule
  -- expected_date in the past.
  v_expected := GREATEST(
    CURRENT_DATE + INTERVAL '14 days',
    COALESCE(v_est.expiry_date, CURRENT_DATE + INTERVAL '14 days')
  )::date;

  INSERT INTO public.sales_orders(
    organization_id, business_id, branch_id, contact_id,
    so_number, status, order_date, expected_date,
    subtotal, tax_amount, discount_amount, total, currency,
    notes, created_by, source_estimate_id
  ) VALUES (
    v_est.organization_id, v_est.business_id, v_est.branch_id, v_est.contact_id,
    v_so_number, 'draft', CURRENT_DATE, v_expected,
    v_subtotal, COALESCE(v_est.tax_amount,0), COALESCE(v_est.discount_amount,0), v_est.total, v_est.currency,
    v_est.notes, p_user_id, p_estimate_id
  )
  RETURNING id INTO v_so_id;

  INSERT INTO public.sales_order_items(
    sales_order_id, product_id, description, quantity, unit_price,
    tax_rate, tax_amount, discount_percent, line_total, sort_order,
    packaging_id, display_uom_id, display_quantity, uom_snapshot
  )
  SELECT
    v_so_id, ei.product_id, ei.description, ei.quantity, ei.unit_price,
    COALESCE(ei.tax_rate,0), COALESCE(ei.tax_amount,0),
    COALESCE(ei.discount_percent,0), ei.line_total, COALESCE(ei.sort_order,0),
    ei.packaging_id, ei.display_uom_id, ei.display_quantity, ei.uom_snapshot
  FROM public.estimate_items ei
  WHERE ei.estimate_id = p_estimate_id;

  SELECT COALESCE(MAX(sort_order), -1) INTO v_max_sort
  FROM public.sales_order_items WHERE sales_order_id = v_so_id;

  INSERT INTO public.sales_order_items(
    sales_order_id, product_id, description, quantity, unit_price,
    tax_rate, tax_amount, discount_percent, line_total, sort_order
  )
  SELECT
    v_so_id, NULL, ac.name, 1, ac.amount,
    COALESCE(ac.tax_rate,0), COALESCE(ac.tax_amount,0), 0, ac.amount,
    v_max_sort + 1 + row_number() OVER (ORDER BY COALESCE(ac.sort_order,0), ac.created_at)
  FROM public.estimate_additional_costs ac
  WHERE ac.estimate_id = p_estimate_id;

  PERFORM set_config('app.estimate_status_writer', '1', true);
  UPDATE public.estimates
  SET status = 'converted',
      converted_sales_order_id = v_so_id,
      converted_at = COALESCE(converted_at, now()),
      updated_at = now()
  WHERE id = p_estimate_id;
  PERFORM set_config('app.estimate_status_writer', '0', true);

  INSERT INTO public.estimate_status_events(
    estimate_id, organization_id, business_id, from_status, to_status, reason, changed_by
  ) VALUES (p_estimate_id, v_est.organization_id, v_est.business_id, v_est.status, 'converted',
            'converted to sales order ' || v_so_number, p_user_id);

  RETURN jsonb_build_object('success', true, 'sales_order_id', v_so_id, 'so_number', v_so_number);
END;
$$;

-- ============================================================
-- Phase 3: RLS convergence on child tables
-- ============================================================
DROP POLICY IF EXISTS "Users can create estimate items" ON public.estimate_items;
DROP POLICY IF EXISTS "Users can update estimate items" ON public.estimate_items;
DROP POLICY IF EXISTS "Users can delete estimate items" ON public.estimate_items;
DROP POLICY IF EXISTS estimate_items_select_perm ON public.estimate_items;
DROP POLICY IF EXISTS estimate_items_insert_perm ON public.estimate_items;
DROP POLICY IF EXISTS estimate_items_update_perm ON public.estimate_items;
DROP POLICY IF EXISTS estimate_items_delete_perm ON public.estimate_items;

CREATE POLICY estimate_items_select_v2 ON public.estimate_items
FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM public.estimates e WHERE e.id = estimate_items.estimate_id
  AND public.user_can_access_business(auth.uid(), e.business_id)
  AND public.user_has_module_permission(auth.uid(), e.organization_id, e.business_id, 'sales', 'view')));

CREATE POLICY estimate_items_insert_v2 ON public.estimate_items
FOR INSERT TO authenticated
WITH CHECK (EXISTS (SELECT 1 FROM public.estimates e WHERE e.id = estimate_items.estimate_id
  AND public.user_can_access_business(auth.uid(), e.business_id)
  AND public.user_has_module_permission(auth.uid(), e.organization_id, e.business_id, 'sales', 'manage')));

CREATE POLICY estimate_items_update_v2 ON public.estimate_items
FOR UPDATE TO authenticated
USING (EXISTS (SELECT 1 FROM public.estimates e WHERE e.id = estimate_items.estimate_id
  AND public.user_can_access_business(auth.uid(), e.business_id)
  AND public.user_has_module_permission(auth.uid(), e.organization_id, e.business_id, 'sales', 'manage')))
WITH CHECK (EXISTS (SELECT 1 FROM public.estimates e WHERE e.id = estimate_items.estimate_id
  AND public.user_can_access_business(auth.uid(), e.business_id)
  AND public.user_has_module_permission(auth.uid(), e.organization_id, e.business_id, 'sales', 'manage')));

CREATE POLICY estimate_items_delete_v2 ON public.estimate_items
FOR DELETE TO authenticated
USING (EXISTS (SELECT 1 FROM public.estimates e WHERE e.id = estimate_items.estimate_id
  AND public.user_can_access_business(auth.uid(), e.business_id)
  AND public.user_has_module_permission(auth.uid(), e.organization_id, e.business_id, 'sales', 'manage')));

DROP POLICY IF EXISTS "Users can view estimate additional costs for their organization" ON public.estimate_additional_costs;
DROP POLICY IF EXISTS "Users can create estimate additional costs for their organizati" ON public.estimate_additional_costs;
DROP POLICY IF EXISTS "Users can update estimate additional costs for their organizati" ON public.estimate_additional_costs;
DROP POLICY IF EXISTS "Users can delete estimate additional costs for their organizati" ON public.estimate_additional_costs;

CREATE POLICY estimate_costs_select_v2 ON public.estimate_additional_costs
FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM public.estimates e WHERE e.id = estimate_additional_costs.estimate_id
  AND public.user_can_access_business(auth.uid(), e.business_id)
  AND public.user_has_module_permission(auth.uid(), e.organization_id, e.business_id, 'sales', 'view')));

CREATE POLICY estimate_costs_insert_v2 ON public.estimate_additional_costs
FOR INSERT TO authenticated
WITH CHECK (EXISTS (SELECT 1 FROM public.estimates e WHERE e.id = estimate_additional_costs.estimate_id
  AND public.user_can_access_business(auth.uid(), e.business_id)
  AND public.user_has_module_permission(auth.uid(), e.organization_id, e.business_id, 'sales', 'manage')));

CREATE POLICY estimate_costs_update_v2 ON public.estimate_additional_costs
FOR UPDATE TO authenticated
USING (EXISTS (SELECT 1 FROM public.estimates e WHERE e.id = estimate_additional_costs.estimate_id
  AND public.user_can_access_business(auth.uid(), e.business_id)
  AND public.user_has_module_permission(auth.uid(), e.organization_id, e.business_id, 'sales', 'manage')))
WITH CHECK (EXISTS (SELECT 1 FROM public.estimates e WHERE e.id = estimate_additional_costs.estimate_id
  AND public.user_can_access_business(auth.uid(), e.business_id)
  AND public.user_has_module_permission(auth.uid(), e.organization_id, e.business_id, 'sales', 'manage')));

CREATE POLICY estimate_costs_delete_v2 ON public.estimate_additional_costs
FOR DELETE TO authenticated
USING (EXISTS (SELECT 1 FROM public.estimates e WHERE e.id = estimate_additional_costs.estimate_id
  AND public.user_can_access_business(auth.uid(), e.business_id)
  AND public.user_has_module_permission(auth.uid(), e.organization_id, e.business_id, 'sales', 'manage')));

-- ============================================================
-- Lineage: direct estimate -> invoice edge
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_document_lineage(p_doc_type text, p_doc_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_estimate_id uuid;
  v_proforma_id uuid;
  v_so_id uuid;
  v_invoice_id uuid;
  v_delivery_id uuid;
  v_org uuid;
  v_business uuid;
  v_est jsonb;
  v_prof jsonb;
  v_so jsonb;
  v_inv jsonb;
  v_dn jsonb;
BEGIN
  IF p_doc_type = 'estimate' THEN
    v_estimate_id := p_doc_id;
    SELECT organization_id, business_id INTO v_org, v_business
      FROM public.estimates WHERE id = v_estimate_id;
    SELECT id INTO v_so_id FROM public.sales_orders WHERE source_estimate_id = v_estimate_id ORDER BY created_at LIMIT 1;
    SELECT id INTO v_invoice_id FROM public.invoices WHERE source_estimate_id = v_estimate_id ORDER BY created_at LIMIT 1;
  ELSIF p_doc_type = 'proforma_invoice' THEN
    v_proforma_id := p_doc_id;
    SELECT organization_id, business_id, source_estimate_id INTO v_org, v_business, v_estimate_id
      FROM public.proforma_invoices WHERE id = v_proforma_id;
  ELSIF p_doc_type = 'sales_order' THEN
    v_so_id := p_doc_id;
    SELECT organization_id, business_id, source_estimate_id, source_proforma_invoice_id
      INTO v_org, v_business, v_estimate_id, v_proforma_id
      FROM public.sales_orders WHERE id = v_so_id;
  ELSIF p_doc_type = 'invoice' THEN
    v_invoice_id := p_doc_id;
    SELECT organization_id, business_id, source_sales_order_id, source_proforma_invoice_id, source_estimate_id
      INTO v_org, v_business, v_so_id, v_proforma_id, v_estimate_id
      FROM public.invoices WHERE id = v_invoice_id;
    IF v_so_id IS NOT NULL AND v_estimate_id IS NULL THEN
      SELECT source_estimate_id INTO v_estimate_id FROM public.sales_orders WHERE id = v_so_id;
    END IF;
  ELSIF p_doc_type = 'delivery_note' THEN
    v_delivery_id := p_doc_id;
    SELECT organization_id, business_id, sales_order_id, source_invoice_id
      INTO v_org, v_business, v_so_id, v_invoice_id
      FROM public.delivery_notes WHERE id = v_delivery_id;
    IF v_so_id IS NOT NULL THEN
      SELECT source_estimate_id, source_proforma_invoice_id INTO v_estimate_id, v_proforma_id
        FROM public.sales_orders WHERE id = v_so_id;
    END IF;
  ELSE
    RAISE EXCEPTION 'Unsupported document type %', p_doc_type;
  END IF;

  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Document % % not found', p_doc_type, p_doc_id;
  END IF;
  IF NOT public.user_can_access_business(auth.uid(), v_business) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE = '42501';
  END IF;

  IF v_estimate_id IS NOT NULL THEN
    SELECT jsonb_build_object('id', id, 'number', estimate_number, 'status', status, 'date', issue_date, 'total', total)
      INTO v_est FROM public.estimates WHERE id = v_estimate_id;
  END IF;
  IF v_proforma_id IS NOT NULL THEN
    SELECT jsonb_build_object('id', id, 'number', proforma_number, 'status', status, 'date', issue_date, 'total', total)
      INTO v_prof FROM public.proforma_invoices WHERE id = v_proforma_id;
  END IF;
  IF v_so_id IS NOT NULL THEN
    SELECT jsonb_build_object('id', id, 'number', so_number, 'status', status, 'date', order_date, 'total', total)
      INTO v_so FROM public.sales_orders WHERE id = v_so_id;
  END IF;
  IF v_invoice_id IS NOT NULL THEN
    SELECT jsonb_build_object('id', id, 'number', invoice_number, 'status', status, 'date', issue_date, 'total', total)
      INTO v_inv FROM public.invoices WHERE id = v_invoice_id;
  END IF;
  IF v_delivery_id IS NOT NULL THEN
    SELECT jsonb_build_object('id', id, 'number', delivery_number, 'status', status, 'date', delivery_date)
      INTO v_dn FROM public.delivery_notes WHERE id = v_delivery_id;
  END IF;

  RETURN jsonb_build_object(
    'estimate', v_est,
    'proforma_invoice', v_prof,
    'sales_order', v_so,
    'invoice', v_inv,
    'delivery_note', v_dn
  );
END;
$$;