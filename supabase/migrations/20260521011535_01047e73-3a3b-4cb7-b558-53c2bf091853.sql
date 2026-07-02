-- =====================================================================
-- Wave 1 — Inventory adjustment integrity hardening (C3 + D3)
-- =====================================================================

-- C3a. Idempotency key column + partial unique index
ALTER TABLE public.stock_adjustments
  ADD COLUMN IF NOT EXISTS client_request_id uuid;

COMMENT ON COLUMN public.stock_adjustments.client_request_id IS
  'Optional caller-supplied idempotency key. When set, apply_or_request_stock_adjustment returns the existing adjustment on conflict instead of creating a duplicate.';

CREATE UNIQUE INDEX IF NOT EXISTS uniq_stock_adjustments_client_request
  ON public.stock_adjustments (organization_id, business_id, client_request_id)
  WHERE client_request_id IS NOT NULL;

-- C3b. Extend apply_or_request_stock_adjustment with idempotency
CREATE OR REPLACE FUNCTION public.apply_or_request_stock_adjustment(
  p_input jsonb,
  p_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_org_id uuid := (p_input->>'organization_id')::uuid;
  v_biz_id uuid := (p_input->>'business_id')::uuid;
  v_branch_id uuid := NULLIF(p_input->>'branch_id','')::uuid;
  v_warehouse_id uuid := (p_input->>'warehouse_id')::uuid;
  v_adjustment_number text := p_input->>'adjustment_number';
  v_reason text := p_input->>'reason';
  v_notes text := p_input->>'notes';
  v_items jsonb := COALESCE(p_input->'items','[]'::jsonb);
  v_client_request_id uuid := NULLIF(p_input->>'client_request_id','')::uuid;
  v_can_write boolean;
  v_user_role text;
  v_is_privileged boolean := false;
  v_total_value numeric := 0;
  v_total_abs_qty numeric := 0;
  v_item jsonb;
  v_before numeric;
  v_rule RECORD;
  v_triggered_rule RECORD;
  v_field_value numeric;
  v_threshold_match boolean;
  v_auto_approve boolean := true;
  v_adjustment_id uuid;
  v_status text;
  v_log_id uuid;
  v_apply_result jsonb;
  v_existing_id uuid;
  v_existing_status text;
  v_existing_gl_posted boolean;
BEGIN
  IF v_org_id IS NULL OR v_biz_id IS NULL OR v_warehouse_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'organization_id, business_id and warehouse_id are required');
  END IF;
  IF jsonb_array_length(v_items) = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'At least one adjustment line is required');
  END IF;

  -- C3 Idempotency: short-circuit if the same client_request_id was already accepted.
  IF v_client_request_id IS NOT NULL THEN
    SELECT id, status INTO v_existing_id, v_existing_status
      FROM public.stock_adjustments
     WHERE organization_id = v_org_id
       AND business_id = v_biz_id
       AND client_request_id = v_client_request_id
     LIMIT 1;
    IF v_existing_id IS NOT NULL THEN
      v_existing_gl_posted := EXISTS (
        SELECT 1 FROM public.journal_entries
         WHERE source_type = 'stock_adjustment'
           AND source_id = v_existing_id
      );
      RETURN jsonb_build_object(
        'success', true,
        'adjustment_id', v_existing_id,
        'status', v_existing_status,
        'requires_approval', v_existing_status = 'pending_approval',
        'auto_applied', v_existing_status = 'approved',
        'gl_posted', v_existing_gl_posted,
        'idempotent', true
      );
    END IF;
  END IF;

  v_can_write := public.user_has_module_permission(p_user_id, v_org_id, 'inventory', 'write');
  IF NOT v_can_write THEN
    RETURN jsonb_build_object('success', false, 'error',
      'You do not have permission to create or apply stock adjustments');
  END IF;

  SELECT role::text INTO v_user_role
    FROM public.user_roles
   WHERE user_id = p_user_id
     AND organization_id = v_org_id
     AND is_active = true
   ORDER BY CASE role::text
              WHEN 'owner' THEN 1
              WHEN 'admin' THEN 2
              ELSE 3
            END
   LIMIT 1;

  v_is_privileged := v_user_role IN ('owner','admin');

  FOR v_item IN SELECT jsonb_array_elements(v_items) LOOP
    v_total_abs_qty := v_total_abs_qty + ABS(COALESCE((v_item->>'quantity_adjustment')::numeric, 0));
    v_total_value   := v_total_value
      + ABS(COALESCE((v_item->>'quantity_adjustment')::numeric, 0))
        * COALESCE((v_item->>'unit_cost')::numeric, 0);
  END LOOP;

  FOR v_rule IN
    SELECT *
      FROM public.approval_rules
     WHERE organization_id = v_org_id
       AND business_id = v_biz_id
       AND entity_type = 'stock_adjustment'
       AND action_name = 'apply'
       AND is_active = true
  LOOP
    v_threshold_match := true;

    IF v_rule.threshold_field IS NOT NULL
       AND v_rule.threshold_operator IS NOT NULL
       AND v_rule.threshold_value IS NOT NULL THEN
      v_field_value := CASE v_rule.threshold_field
        WHEN 'total_value'   THEN v_total_value
        WHEN 'total_abs_qty' THEN v_total_abs_qty
        ELSE 0
      END;
      v_threshold_match := CASE v_rule.threshold_operator
        WHEN '>'  THEN v_field_value >  v_rule.threshold_value
        WHEN '>=' THEN v_field_value >= v_rule.threshold_value
        WHEN '<'  THEN v_field_value <  v_rule.threshold_value
        WHEN '<=' THEN v_field_value <= v_rule.threshold_value
        WHEN '='  THEN v_field_value =  v_rule.threshold_value
        WHEN '==' THEN v_field_value =  v_rule.threshold_value
        WHEN '!=' THEN v_field_value <> v_rule.threshold_value
        ELSE false
      END;
    END IF;

    IF v_threshold_match THEN
      IF v_is_privileged THEN
        CONTINUE;
      END IF;
      v_triggered_rule := v_rule;
      v_auto_approve := false;
      EXIT;
    END IF;
  END LOOP;

  v_status := CASE WHEN v_auto_approve THEN 'draft' ELSE 'pending_approval' END;

  INSERT INTO public.stock_adjustments (
    organization_id, business_id, branch_id, warehouse_id,
    adjustment_number, reason, notes, status, created_by, client_request_id
  ) VALUES (
    v_org_id, v_biz_id, v_branch_id, v_warehouse_id,
    v_adjustment_number, v_reason, v_notes, v_status, p_user_id, v_client_request_id
  )
  RETURNING id INTO v_adjustment_id;

  FOR v_item IN SELECT jsonb_array_elements(v_items) LOOP
    SELECT COALESCE(quantity, 0) INTO v_before
      FROM public.warehouse_stock
     WHERE product_id = (v_item->>'product_id')::uuid
       AND warehouse_id = (v_item->>'warehouse_id')::uuid
     LIMIT 1;
    v_before := COALESCE(v_before, 0);

    INSERT INTO public.stock_adjustment_items (
      adjustment_id, product_id, warehouse_id, branch_id,
      quantity_before, quantity_adjustment, quantity_after,
      unit_cost, notes
    ) VALUES (
      v_adjustment_id,
      (v_item->>'product_id')::uuid,
      (v_item->>'warehouse_id')::uuid,
      v_branch_id,
      v_before,
      COALESCE((v_item->>'quantity_adjustment')::numeric, 0),
      v_before + COALESCE((v_item->>'quantity_adjustment')::numeric, 0),
      NULLIF(v_item->>'unit_cost','')::numeric,
      v_item->>'notes'
    );
  END LOOP;

  IF v_auto_approve THEN
    v_apply_result := public.approve_stock_adjustment_atomic(v_adjustment_id, p_user_id);
    IF NOT (v_apply_result->>'success')::boolean THEN
      RAISE EXCEPTION 'Auto-apply failed: %', v_apply_result->>'error';
    END IF;
    RETURN jsonb_build_object(
      'success', true,
      'adjustment_id', v_adjustment_id,
      'status', 'approved',
      'requires_approval', false,
      'auto_applied', true,
      'gl_posted', COALESCE((v_apply_result->>'gl_posted')::boolean, false),
      'total_value', v_total_value
    );
  ELSE
    INSERT INTO public.approval_rule_logs (
      organization_id, business_id, rule_id,
      entity_type, entity_id, action_name,
      status, requested_by, notes
    ) VALUES (
      v_org_id, v_biz_id, v_triggered_rule.id,
      'stock_adjustment', v_adjustment_id::text, 'apply',
      'pending', p_user_id,
      COALESCE(v_triggered_rule.description,
        'Stock adjustment requires approval (rule triggered)')
    )
    RETURNING id INTO v_log_id;

    RETURN jsonb_build_object(
      'success', true,
      'adjustment_id', v_adjustment_id,
      'status', 'pending_approval',
      'requires_approval', true,
      'auto_applied', false,
      'rule_id', v_triggered_rule.id,
      'rule_name', COALESCE(v_triggered_rule.description, 'Approval rule'),
      'approval_log_id', v_log_id,
      'total_value', v_total_value
    );
  END IF;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.apply_or_request_stock_adjustment(jsonb, uuid) TO authenticated, service_role;

-- D3. Immutability triggers ---------------------------------------------
-- Once an adjustment is approved or reversed, its line items are frozen
-- and the header may only change via the controlled status / reversal
-- columns. Everything else is a hard error.

CREATE OR REPLACE FUNCTION public.enforce_stock_adjustment_header_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('approved', 'reversed') THEN
      RAISE EXCEPTION 'Stock adjustment % cannot be deleted once it is %', OLD.id, OLD.status;
    END IF;
    RETURN OLD;
  END IF;

  -- UPDATE path.
  IF OLD.status IN ('approved', 'reversed') THEN
    -- Allow only specific column changes after approval.
    -- These are: status (approved -> reversed), reversed_by_adjustment_id,
    -- reversal_reason (D2 wave), and updated_at.
    IF NEW.organization_id     IS DISTINCT FROM OLD.organization_id
    OR NEW.business_id         IS DISTINCT FROM OLD.business_id
    OR NEW.branch_id           IS DISTINCT FROM OLD.branch_id
    OR NEW.warehouse_id        IS DISTINCT FROM OLD.warehouse_id
    OR NEW.adjustment_number   IS DISTINCT FROM OLD.adjustment_number
    OR NEW.reason              IS DISTINCT FROM OLD.reason
    OR NEW.notes               IS DISTINCT FROM OLD.notes
    OR NEW.approved_by         IS DISTINCT FROM OLD.approved_by
    OR NEW.approved_at         IS DISTINCT FROM OLD.approved_at
    OR NEW.created_by          IS DISTINCT FROM OLD.created_by
    OR NEW.created_at          IS DISTINCT FROM OLD.created_at
    OR NEW.client_request_id   IS DISTINCT FROM OLD.client_request_id
    THEN
      RAISE EXCEPTION 'Stock adjustment % is locked (status=%); only status / reversal links may change', OLD.id, OLD.status;
    END IF;

    -- Allowed status transitions: approved -> reversed only.
    IF NEW.status IS DISTINCT FROM OLD.status
       AND NOT (OLD.status = 'approved' AND NEW.status = 'reversed') THEN
      RAISE EXCEPTION 'Illegal status transition % -> % on stock adjustment %', OLD.status, NEW.status, OLD.id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_stock_adjustment_immutability ON public.stock_adjustments;
CREATE TRIGGER trg_enforce_stock_adjustment_immutability
  BEFORE UPDATE OR DELETE ON public.stock_adjustments
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_stock_adjustment_header_immutability();

CREATE OR REPLACE FUNCTION public.enforce_stock_adjustment_items_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_parent_status text;
BEGIN
  SELECT status INTO v_parent_status
    FROM public.stock_adjustments
   WHERE id = COALESCE(NEW.adjustment_id, OLD.adjustment_id);

  IF v_parent_status IN ('approved', 'reversed') THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'Stock adjustment line items are frozen once the parent is %', v_parent_status;
    END IF;
    -- approve_stock_adjustment_atomic writes the resolved unit_cost BEFORE
    -- flipping status to 'approved'. After that, all line-item fields are
    -- frozen.
    RAISE EXCEPTION 'Stock adjustment line items are frozen once the parent is %', v_parent_status;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_stock_adjustment_items_immutability ON public.stock_adjustment_items;
CREATE TRIGGER trg_enforce_stock_adjustment_items_immutability
  BEFORE UPDATE OR DELETE ON public.stock_adjustment_items
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_stock_adjustment_items_immutability();

COMMENT ON FUNCTION public.enforce_stock_adjustment_header_immutability() IS
  'Wave 1 D3 — locks approved/reversed stock adjustments. Only status (approved->reversed) and reversal link columns may change. See docs/audit/2026-05-21-inventory-adjustment-gl.md.';
COMMENT ON FUNCTION public.enforce_stock_adjustment_items_immutability() IS
  'Wave 1 D3 — freezes stock_adjustment_items once parent is approved or reversed.';
