-- =====================================================================
-- Governance Wave 3 patch — extend teardown-context bypass to the
-- stock_movements immutability guard.
--
-- ROOT CAUSE
-- ----------
-- `enforce_stock_movement_immutability` (introduced 2026-05-27 in the
-- Inventory UoM Phase 0 migration, then re-stated 2026-05-27 in the
-- provenance back-fill migration) is the only operational immutability
-- trigger that fires on DELETE of historical rows and does NOT honour
-- the canonical teardown GUC `app.reset_in_progress` documented in
-- ADR 0019 (Workspace Governance Plane).
--
-- The governance reset path (clear-org-data → reset_organization_data
-- / reset_module__inventory) sets that GUC txn-locally and then issues
--   DELETE FROM public.stock_movements WHERE organization_id = org_id;
-- The trigger fires unconditionally and aborts the whole transaction
-- with:
--   [reset_organization_data] stock_movements rows cannot be deleted
--     (code: P0001)
-- leaving the workspace half-wiped from the caller's perspective even
-- though the outer txn rolls back cleanly.
--
-- DECISION (matches the 22 Wave 1/2 triggers already retrofit)
-- ------------------------------------------------------------
-- Add the canonical bypass predicate as the FIRST statement of the
-- trigger body, scoped to the row's own organization_id:
--   IF public._is_teardown_for_org(
--        COALESCE(NEW.organization_id, OLD.organization_id)
--   ) THEN RETURN COALESCE(NEW, OLD); END IF;
--
-- This is NOT a generic bypass: `_is_teardown_for_org` only returns
-- true when the txn-local GUC `app.reset_in_progress` equals the row's
-- organization_id, and only governance.* SECURITY DEFINER functions are
-- allowed to set that GUC (architecture-test enforced).
--
-- The legacy `app.allow_movement_mutation = 'true'` escape hatch that
-- was present in the Phase 0 definition is preserved so any existing
-- compensating-movement tooling keeps working.
--
-- The substantive ledger immutability (no application-code DELETEs, no
-- field mutation outside provenance back-fill) is otherwise unchanged.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.enforce_stock_movement_immutability()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- 1) Governance teardown context (ADR 0019). Wave 1/2 pattern.
  IF public._is_teardown_for_org(
       COALESCE(NEW.organization_id, OLD.organization_id)
     ) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- 2) Legacy compensating-movement escape hatch (kept for back-compat
  --    with code paths that explicitly opt in inside a single txn).
  IF current_setting('app.allow_movement_mutation', true) = 'true' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  -- 3) UPDATE — allow provenance back-fill only (source_packaging_id /
  --    source_uom_id). Every other column is frozen.
  IF TG_OP = 'UPDATE' THEN
    IF (
      NEW.organization_id IS DISTINCT FROM OLD.organization_id OR
      NEW.business_id     IS DISTINCT FROM OLD.business_id     OR
      NEW.branch_id       IS DISTINCT FROM OLD.branch_id       OR
      NEW.product_id      IS DISTINCT FROM OLD.product_id      OR
      NEW.warehouse_id    IS DISTINCT FROM OLD.warehouse_id    OR
      NEW.movement_type   IS DISTINCT FROM OLD.movement_type   OR
      NEW.quantity        IS DISTINCT FROM OLD.quantity        OR
      NEW.unit_cost       IS DISTINCT FROM OLD.unit_cost       OR
      NEW.reference_type  IS DISTINCT FROM OLD.reference_type  OR
      NEW.reference_id    IS DISTINCT FROM OLD.reference_id    OR
      NEW.movement_date   IS DISTINCT FROM OLD.movement_date
    ) THEN
      RAISE EXCEPTION 'stock_movements rows are immutable except for provenance back-fill';
    END IF;
    RETURN NEW;
  END IF;

  -- 4) DELETE outside a governance teardown is forbidden.
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'stock_movements rows cannot be deleted (ledger is append-only; post a compensating movement, or run via the governance teardown RPC)';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

-- Trigger binding is unchanged (BEFORE UPDATE OR DELETE), redefined
-- defensively in case the binding was dropped by an out-of-band script.
DROP TRIGGER IF EXISTS trg_enforce_stock_movement_immutability
  ON public.stock_movements;
CREATE TRIGGER trg_enforce_stock_movement_immutability
  BEFORE UPDATE OR DELETE ON public.stock_movements
  FOR EACH ROW EXECUTE FUNCTION public.enforce_stock_movement_immutability();

COMMENT ON FUNCTION public.enforce_stock_movement_immutability() IS
  'Stock ledger immutability guard. Honours the governance teardown GUC '
  '(app.reset_in_progress = organization_id, set txn-local by '
  'reset_organization_data / reset_module__* RPCs per ADR 0019) and the '
  'legacy app.allow_movement_mutation escape hatch. Outside those two '
  'contexts, DELETE is forbidden and UPDATE only allows provenance back-fill.';
