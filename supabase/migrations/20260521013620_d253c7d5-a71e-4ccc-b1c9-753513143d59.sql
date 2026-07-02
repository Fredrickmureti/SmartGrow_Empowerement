-- Wave 3 closeout — ADR 0016 enforcement (immutability + missing-JE detector).
CREATE OR REPLACE FUNCTION public.prevent_approved_adjustment_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF OLD.status <> 'approved' THEN
    RETURN NEW;
  END IF;

  -- Allowed transition: approved → reversed with reversed_by_adjustment_id set.
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
$$;

COMMENT ON FUNCTION public.prevent_approved_adjustment_mutation() IS
  'ADR 0016 — BEFORE UPDATE guard on stock_adjustments. Rejects every mutation of an approved row except the approved->reversed linkage write performed by reverse_stock_adjustment_atomic.';

DROP TRIGGER IF EXISTS trg_prevent_approved_adjustment_mutation ON public.stock_adjustments;
CREATE TRIGGER trg_prevent_approved_adjustment_mutation
BEFORE UPDATE ON public.stock_adjustments
FOR EACH ROW
EXECUTE FUNCTION public.prevent_approved_adjustment_mutation();

CREATE OR REPLACE FUNCTION public.list_adjustments_missing_journals(
  p_organization_id uuid,
  p_business_id uuid,
  p_branch_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 500
)
RETURNS TABLE (
  id uuid,
  adjustment_number text,
  adjustment_date date,
  reason text,
  status text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT sa.id, sa.adjustment_number, sa.adjustment_date, sa.reason, sa.status
    FROM public.stock_adjustments sa
   WHERE sa.organization_id = p_organization_id
     AND sa.business_id     = p_business_id
     AND sa.status          = 'approved'
     AND (p_branch_id IS NULL OR sa.branch_id = p_branch_id)
     AND NOT EXISTS (
       SELECT 1 FROM public.journal_entries je
        WHERE je.source_type = 'stock_adjustment'
          AND je.source_id   = sa.id
     )
   ORDER BY sa.adjustment_date DESC
   LIMIT GREATEST(p_limit, 1);
$$;

GRANT EXECUTE ON FUNCTION public.list_adjustments_missing_journals(uuid, uuid, uuid, integer)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.list_adjustments_missing_journals(uuid, uuid, uuid, integer) IS
  'ADR 0016 — canonical NOT-EXISTS detector for approved adjustments that never posted a JE. Used by the Inventory Reconciliation card.';