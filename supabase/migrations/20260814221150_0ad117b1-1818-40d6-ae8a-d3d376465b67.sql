-- Phase 4 — Warehouse consumes the Inventory ledger; it never invents its own
-- identity columns on it.
--
-- Defect: wms_split_putaway_task located the staged quant with
--   package_id = v_task.lpn_id
-- and stamped the new child plate the same way. `stock_quants.package_id` is a
-- FK to product_packaging (ADR 0064) — the physical container column is
-- `lpn_id`. Consequences: (a) a product_packaging FK holding an LPN id, (b) the
-- source UPDATE could never match plate quants written by wms_lpn_load /
-- wms_lpn_split (which use lpn_id), so the split silently failed or hit the
-- wrong row, (c) no stock_movements audit for a physical bin-to-bin move.
--
-- Movement rows use reference_type = 'wms_lpn' so _maintain_stock_quants skips
-- them (see that trigger): plate-scoped quants are relocated explicitly here,
-- exactly as wms_lpn_move does. That keeps the audit trail without
-- double-applying the balance.

CREATE OR REPLACE FUNCTION public.wms_split_putaway_task(
  p_task_id uuid,
  p_row_version integer,
  p_quantity numeric,
  p_location_id uuid DEFAULT NULL::uuid,
  p_reason text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_task record; v_dest uuid; v_fit jsonb; v_remaining numeric;
  v_new_lpn uuid; v_code text; v_child_task uuid;
  v_src public.stock_quants;
BEGIN
  IF p_row_version IS NULL THEN
    RAISE EXCEPTION 'wms_task_version_required: p_row_version is mandatory' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_task FROM public.wms_tasks WHERE id = p_task_id FOR UPDATE;
  IF v_task.id IS NULL THEN RAISE EXCEPTION 'task % not found', p_task_id USING ERRCODE = 'P0002'; END IF;
  IF v_task.row_version <> p_row_version THEN
    RAISE EXCEPTION 'wms_task_stale: expected v% got v%', p_row_version, v_task.row_version
      USING ERRCODE = '40001';
  END IF;
  IF NOT user_can_access_business(auth.uid(), v_task.business_id) THEN RAISE EXCEPTION 'access denied'; END IF;
  IF v_task.task_type <> 'putaway' THEN RAISE EXCEPTION 'task is not putaway'; END IF;
  IF v_task.state IN ('completed','cancelled') THEN RAISE EXCEPTION 'task already %', v_task.state; END IF;
  IF COALESCE(p_quantity,0) <= 0 THEN RAISE EXCEPTION 'quantity must be positive'; END IF;
  IF p_quantity >= COALESCE(v_task.quantity,0) THEN
    RAISE EXCEPTION 'use complete_putaway_task for the full quantity';
  END IF;

  v_dest := COALESCE(p_location_id, v_task.destination_location_id);
  IF v_dest IS NULL THEN RAISE EXCEPTION 'no destination bin'; END IF;
  PERFORM 1 FROM public.stock_locations WHERE id = v_dest AND warehouse_id = v_task.warehouse_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'bin is not in this warehouse'; END IF;

  v_fit := public.wms_location_feasible(v_dest, v_task.product_id, p_quantity, v_task.lot_number);
  IF NOT (v_fit->>'feasible')::boolean
     OR COALESCE((v_fit->>'feasible_qty')::numeric,0) < p_quantity THEN
    IF p_reason IS NULL OR btrim(p_reason) = '' THEN
      RAISE EXCEPTION 'bin rejected: %', COALESCE(v_fit->>'reason','insufficient capacity');
    END IF;
  END IF;

  v_remaining := COALESCE(v_task.quantity,0) - p_quantity;

  -- Take the split portion out of the staged plate's quant. `lpn_id` is the
  -- physical-container column; package_id is a product_packaging FK and must
  -- never hold a plate id.
  SELECT * INTO v_src FROM public.stock_quants
   WHERE lpn_id = v_task.lpn_id
     AND product_id = v_task.product_id
     AND location_id = v_task.source_location_id
     AND lot_number IS NOT DISTINCT FROM v_task.lot_number
   FOR UPDATE;
  IF v_src.id IS NULL
     OR (COALESCE(v_src.quantity,0) - COALESCE(v_src.reserved_quantity,0)) < p_quantity THEN
    RAISE EXCEPTION 'staged quantity not available to split' USING ERRCODE = '22023';
  END IF;

  UPDATE public.stock_quants
     SET quantity = quantity - p_quantity, updated_at = now()
   WHERE id = v_src.id;
  DELETE FROM public.stock_quants
   WHERE id = v_src.id AND quantity = 0 AND COALESCE(reserved_quantity,0) = 0;

  v_code := 'LPN-' || to_char(now(),'YY') || upper(substr(md5(gen_random_uuid()::text),1,6));
  INSERT INTO public.wms_license_plates (
    organization_id, business_id, branch_id, warehouse_id,
    code, lpn_type, status, current_location_id, created_by)
  VALUES (v_task.organization_id, v_task.business_id, v_task.branch_id, v_task.warehouse_id,
          v_code, 'pallet', 'open', v_dest, auth.uid())
  RETURNING id INTO v_new_lpn;

  -- Audit the physical relocation. reference_type 'wms_lpn' makes
  -- _maintain_stock_quants skip these rows: the quants are relocated here.
  INSERT INTO public.stock_movements (
    organization_id, business_id, branch_id, warehouse_id, product_id,
    movement_type, quantity, source_location_id, destination_location_id,
    lot_number, reference_type, reference_id, notes, created_by, movement_date)
  VALUES
    (v_task.organization_id, v_task.business_id, v_task.branch_id, v_task.warehouse_id,
     v_task.product_id, 'transfer_out', -p_quantity, v_task.source_location_id, v_dest,
     v_task.lot_number, 'wms_lpn', v_new_lpn,
     COALESCE(p_reason, 'Partial putaway ' || v_code), auth.uid(), now()),
    (v_task.organization_id, v_task.business_id, v_task.branch_id, v_task.warehouse_id,
     v_task.product_id, 'transfer_in', p_quantity, v_task.source_location_id, v_dest,
     v_task.lot_number, 'wms_lpn', v_new_lpn,
     COALESCE(p_reason, 'Partial putaway ' || v_code), auth.uid(), now());

  INSERT INTO public.stock_quants (
    organization_id, business_id, branch_id,
    product_id, location_id, lot_number, package_id, owner_id, quantity, lpn_id)
  VALUES (v_task.organization_id, v_task.business_id, v_task.branch_id,
          v_task.product_id, v_dest, v_task.lot_number,
          v_src.package_id, v_src.owner_id, p_quantity, v_new_lpn);

  -- Audit child task recording the stored portion.
  INSERT INTO public.wms_tasks (
    organization_id, business_id, branch_id, warehouse_id,
    task_type, state, priority, source_doc_type, source_doc_id,
    source_location_id, destination_location_id,
    product_id, lot_number, lpn_id, quantity, metadata, created_by,
    started_at, completed_at, assignee_user_id)
  VALUES (v_task.organization_id, v_task.business_id, v_task.branch_id, v_task.warehouse_id,
    'putaway', 'completed', v_task.priority, v_task.source_doc_type, v_task.source_doc_id,
    v_task.source_location_id, v_dest,
    v_task.product_id, v_task.lot_number, v_new_lpn, p_quantity,
    jsonb_build_object('split_from_task_id', p_task_id, 'split_reason', p_reason,
                       'feasibility', v_fit),
    auth.uid(), now(), now(), auth.uid())
  RETURNING id INTO v_child_task;

  UPDATE public.wms_tasks
     SET quantity = v_remaining,
         state = CASE WHEN state = 'pending' THEN 'in_progress' ELSE state END,
         row_version = v_task.row_version + 1,
         metadata = COALESCE(metadata,'{}'::jsonb) || jsonb_build_object(
           'last_split_task_id', v_child_task,
           'last_split_quantity', p_quantity,
           'last_split_at', now())
   WHERE id = p_task_id;

  RETURN jsonb_build_object('task_id', p_task_id, 'child_task_id', v_child_task,
    'lpn_id', v_new_lpn, 'stored', p_quantity, 'remaining', v_remaining,
    'row_version', v_task.row_version + 1);
END; $function$;

-- Structural safeguard: stock_quants.package_id is the product_packaging
-- dimension (ADR 0064). Nothing may put a license plate id there again.
CREATE OR REPLACE FUNCTION public._stock_quants_package_id_is_packaging()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.package_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.wms_license_plates WHERE id = NEW.package_id) THEN
    RAISE EXCEPTION 'INVENTORY_QUANT_PACKAGE_IS_LPN: stock_quants.package_id must reference product_packaging; use lpn_id for the physical container'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $function$;

DROP TRIGGER IF EXISTS trg_stock_quants_package_id_is_packaging ON public.stock_quants;
CREATE TRIGGER trg_stock_quants_package_id_is_packaging
BEFORE INSERT OR UPDATE OF package_id ON public.stock_quants
FOR EACH ROW EXECUTE FUNCTION public._stock_quants_package_id_is_packaging();