CREATE OR REPLACE FUNCTION public.emit_scrap_lifecycle_events()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_event text;
  v_total numeric;
BEGIN
  IF NEW.adjustment_type <> 'scrap' THEN
    RETURN NEW;
  END IF;

  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  IF NEW.status IN ('approved','posted') AND OLD.status NOT IN ('approved','posted') THEN
    v_event := 'scrap.posted';
  ELSIF NEW.status = 'reversed' AND OLD.status <> 'reversed' THEN
    v_event := 'scrap.reversed';
  ELSE
    RETURN NEW;
  END IF;

  SELECT COALESCE(SUM(ABS(quantity_adjustment) * COALESCE(unit_cost, 0)), 0)
    INTO v_total
    FROM public.stock_adjustment_items
   WHERE adjustment_id = NEW.id;

  INSERT INTO public.business_event_outbox (
    org_id, branch_id, warehouse_id, event_type,
    source_doc_type, source_doc_id, payload,
    idempotency_key, actor_user_id, source
  ) VALUES (
    NEW.organization_id,
    NEW.branch_id,
    NEW.warehouse_id,
    v_event,
    'stock_adjustment',
    NEW.id,
    jsonb_build_object(
      'adjustment_id', NEW.id,
      'adjustment_number', NEW.adjustment_number,
      'business_id', NEW.business_id,
      'branch_id', NEW.branch_id,
      'warehouse_id', NEW.warehouse_id,
      'reason', NEW.reason,
      'total_value', v_total,
      'from_status', OLD.status,
      'to_status', NEW.status,
      'event_source', 'scrap_lifecycle'
    ),
    'scrap:' || NEW.id::text || ':' || v_event,
    COALESCE(NEW.approved_by, NEW.created_by),
    'trigger'
  )
  ON CONFLICT (org_id, idempotency_key) DO NOTHING;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.record_scrap_atomic(
  p_organization_id uuid,
  p_business_id uuid,
  p_product_id uuid,
  p_warehouse_id uuid,
  p_quantity numeric,
  p_unit_cost numeric,
  p_reason text,
  p_notes text,
  p_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_adj_id uuid;
  v_adj_number text;
  v_qty_abs numeric := abs(coalesce(p_quantity, 0));
  v_qty_before numeric;
  v_branch_id uuid;
  v_reason text := coalesce(nullif(trim(p_reason), ''), 'scrap');
  v_result jsonb;
BEGIN
  IF p_organization_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Scrap requires an organization');
  END IF;

  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Scrap requires a signed-in user');
  END IF;

  IF p_business_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Scrap requires a company');
  END IF;

  IF p_product_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Scrap requires a product');
  END IF;

  IF p_warehouse_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Scrap requires a warehouse');
  END IF;

  IF v_qty_abs <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Scrap quantity must be positive');
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.products p
     WHERE p.id = p_product_id
       AND p.organization_id = p_organization_id
       AND p.business_id = p_business_id
       AND p.type = 'product'
       AND COALESCE(p.is_active, true) = true
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Selected product is not an active inventory product for this company');
  END IF;

  SELECT w.branch_id
    INTO v_branch_id
    FROM public.warehouses w
   WHERE w.id = p_warehouse_id
     AND w.organization_id = p_organization_id
     AND w.business_id = p_business_id
     AND COALESCE(w.is_active, true) = true;

  IF v_branch_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Selected warehouse is not active for this company');
  END IF;

  v_adj_number := 'SCR-' || to_char(now(), 'YYYY') || '-'
    || lpad((coalesce((
        SELECT max(nullif(regexp_replace(adjustment_number, '^SCR-\d{4}-', ''), '')::int)
          FROM public.stock_adjustments
         WHERE organization_id = p_organization_id
           AND adjustment_number ~ ('^SCR-' || to_char(now(), 'YYYY') || '-\d+$')
      ), 0) + 1)::text, 5, '0');

  SELECT coalesce(quantity, 0)
    INTO v_qty_before
    FROM public.warehouse_stock
   WHERE product_id = p_product_id
     AND warehouse_id = p_warehouse_id
     AND business_id = p_business_id;
  v_qty_before := coalesce(v_qty_before, 0);

  INSERT INTO public.stock_adjustments (
    organization_id, business_id, branch_id, warehouse_id,
    adjustment_number, adjustment_date, adjustment_type,
    reason, notes, status, created_by
  ) VALUES (
    p_organization_id, p_business_id, v_branch_id, p_warehouse_id,
    v_adj_number, now(), 'scrap',
    v_reason,
    coalesce(p_notes, ''),
    'draft', p_user_id
  ) RETURNING id INTO v_adj_id;

  INSERT INTO public.stock_adjustment_items (
    adjustment_id, product_id, warehouse_id, branch_id,
    quantity_before, quantity_adjustment, quantity_after,
    unit_cost, notes
  ) VALUES (
    v_adj_id, p_product_id, p_warehouse_id, v_branch_id,
    v_qty_before,
    -v_qty_abs,
    v_qty_before - v_qty_abs,
    nullif(p_unit_cost, 0),
    v_reason
  );

  v_result := public.approve_stock_adjustment_atomic(v_adj_id, p_user_id);

  IF coalesce((v_result->>'success')::boolean, false) IS NOT TRUE THEN
    RETURN v_result;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'adjustment_id', v_adj_id,
    'adjustment_number', v_adj_number,
    'movement_id', NULL,
    'gl_posted', coalesce((v_result->>'gl_posted')::boolean, false),
    'journal_entry_id', v_result->>'journal_entry_id'
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.record_scrap_atomic(uuid, uuid, uuid, uuid, numeric, numeric, text, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_scrap_atomic(uuid, uuid, uuid, uuid, numeric, numeric, text, text, uuid) TO service_role;
COMMENT ON FUNCTION public.record_scrap_atomic(uuid, uuid, uuid, uuid, numeric, numeric, text, text, uuid) IS
  'Creates a scrap stock_adjustment document and posts it through approve_stock_adjustment_atomic after validating company, product, and warehouse scope.';