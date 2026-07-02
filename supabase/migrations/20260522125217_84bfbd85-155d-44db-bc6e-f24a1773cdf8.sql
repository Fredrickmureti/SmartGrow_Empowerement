
-- =====================================================================
-- Wave 1 — Privileged teardown context recognition
-- =====================================================================
-- Background: reset_categories() and reset_organization_data() already
-- set the txn-local GUC `app.reset_in_progress = <org_id>`. The journal-
-- entry triggers honour it; the stock-adjustment and sales-order guards
-- do not, so they fire during a legitimate teardown and abort the reset
-- with errors like:
--   "Stock adjustment line items are frozen once the parent is approved"
-- This migration adds the same bypass pattern used by JE triggers.
-- =====================================================================

-- Shared helper so every trigger uses the exact same predicate.
-- Returns true iff the current transaction is a privileged reset for the
-- given org. The GUC is txn-local (set_config(..., true)), so it cannot
-- leak outside the reset RPC's transaction.
CREATE OR REPLACE FUNCTION public._is_teardown_for_org(p_org uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(NULLIF(current_setting('app.reset_in_progress', true), ''), '') = p_org::text;
$$;

COMMENT ON FUNCTION public._is_teardown_for_org(uuid) IS
  'Returns true when the current transaction is a privileged workspace teardown for the given org. '
  'Set by reset_categories / reset_organization_data via set_config(''app.reset_in_progress'', org_id, true). '
  'Operational immutability triggers check this to allow governance-plane DELETE/UPDATE while keeping '
  'normal user mutations blocked. See ADR 0019 (planned) — Workspace Governance Plane.';


-- ---------------------------------------------------------------------
-- 1. enforce_stock_adjustment_items_immutability
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_stock_adjustment_items_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  v_parent_status text;
  v_parent_org    uuid;
BEGIN
  SELECT status, organization_id INTO v_parent_status, v_parent_org
    FROM public.stock_adjustments
   WHERE id = COALESCE(NEW.adjustment_id, OLD.adjustment_id);

  -- Governance plane: privileged teardown is allowed to wipe history.
  IF v_parent_org IS NOT NULL AND public._is_teardown_for_org(v_parent_org) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF v_parent_status IN ('approved', 'reversed') THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'Stock adjustment line items are frozen once the parent is %', v_parent_status;
    END IF;
    RAISE EXCEPTION 'Stock adjustment line items are frozen once the parent is %', v_parent_status;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$function$;


-- ---------------------------------------------------------------------
-- 2. enforce_stock_adjustment_header_immutability
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_stock_adjustment_header_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  -- Governance plane: privileged teardown is allowed to wipe history.
  IF public._is_teardown_for_org(COALESCE(NEW.organization_id, OLD.organization_id)) THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('approved', 'reversed') THEN
      RAISE EXCEPTION 'Stock adjustment % cannot be deleted once it is %', OLD.id, OLD.status;
    END IF;
    RETURN OLD;
  END IF;

  -- UPDATE path.
  IF OLD.status IN ('approved', 'reversed') THEN
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

    IF NEW.status IS DISTINCT FROM OLD.status
       AND NOT (OLD.status = 'approved' AND NEW.status = 'reversed') THEN
      RAISE EXCEPTION 'Illegal status transition % -> % on stock adjustment %', OLD.status, NEW.status, OLD.id;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;


-- ---------------------------------------------------------------------
-- 3. prevent_approved_adjustment_mutation
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.prevent_approved_adjustment_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  -- Governance plane: privileged teardown is allowed to wipe history.
  IF public._is_teardown_for_org(COALESCE(NEW.organization_id, OLD.organization_id)) THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  IF OLD.status <> 'approved' THEN
    RETURN NEW;
  END IF;

  IF NEW.status = 'reversed'
     AND OLD.reversed_by_adjustment_id IS NULL
     AND NEW.reversed_by_adjustment_id IS NOT NULL
  THEN
    IF ROW(NEW.organization_id, NEW.business_id, NEW.branch_id,
           NEW.adjustment_number, NEW.adjustment_date, NEW.reason,
           NEW.notes, NEW.total_value, NEW.warehouse_id,
           NEW.created_by, NEW.approved_by, NEW.approved_at,
           NEW.reverses_adjustment_id, NEW.client_request_id)
       IS DISTINCT FROM
       ROW(OLD.organization_id, OLD.business_id, OLD.branch_id,
           OLD.adjustment_number, OLD.adjustment_date, OLD.reason,
           OLD.notes, OLD.total_value, OLD.warehouse_id,
           OLD.created_by, OLD.approved_by, OLD.approved_at,
           OLD.reverses_adjustment_id, OLD.client_request_id)
    THEN
      RAISE EXCEPTION 'Approved stock adjustment % is immutable. Only the reversal linkage may be set. See ADR 0016.',
        OLD.id USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Approved stock adjustment % is immutable (status=%). Use reverse_stock_adjustment_atomic to correct. See ADR 0016.',
    OLD.id, OLD.status USING ERRCODE = 'check_violation';
END;
$function$;


-- ---------------------------------------------------------------------
-- 4. enforce_sales_order_delete_status
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_sales_order_delete_status()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  -- Governance plane: privileged teardown is allowed to wipe history.
  IF public._is_teardown_for_org(OLD.organization_id) THEN
    RETURN OLD;
  END IF;

  IF OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'Cannot delete sales order % with status %. Only draft orders can be deleted.',
      OLD.so_number, OLD.status;
  END IF;
  RETURN OLD;
END;
$function$;
