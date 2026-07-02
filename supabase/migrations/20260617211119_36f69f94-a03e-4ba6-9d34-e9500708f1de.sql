
-- Fix 1: GRN status mismatch — RPC sets 'completed' but trigger only fires on 'posted'.
-- Update trigger to fire on the actual terminal status. Keep 'posted' compatible
-- for any future flow that sets it explicitly.
CREATE OR REPLACE FUNCTION public.tg_goods_receipt_emit_posted()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid;
  v_terminal boolean;
  v_was_terminal boolean;
BEGIN
  v_terminal     := NEW.status IN ('completed','posted');
  v_was_terminal := COALESCE(OLD.status, '') IN ('completed','posted');

  IF v_terminal AND NOT v_was_terminal THEN
    SELECT po.business_id INTO v_org
    FROM public.purchase_orders po WHERE po.id = NEW.purchase_order_id;

    IF v_org IS NOT NULL THEN
      PERFORM public.publish_business_event(
        v_org,
        NEW.branch_id,
        NEW.warehouse_id,
        'goods_receipt.posted',
        'goods_receipt',
        NEW.id,
        jsonb_build_object('grn_id', NEW.id, 'purchase_order_id', NEW.purchase_order_id, 'status', NEW.status),
        'grn-posted:' || NEW.id::text,
        auth.uid()
      );
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- Fix 4: claim_next_hardware_command silently ignored p_branch_id.
-- Replace with branch-aware variant. Keep default NULL so existing callers
-- (no branch passed) get org-wide behaviour unchanged.
CREATE OR REPLACE FUNCTION public.claim_next_hardware_command(
  p_org_id uuid,
  p_claimant text,
  p_limit int DEFAULT 1,
  p_branch_id uuid DEFAULT NULL
) RETURNS SETOF public.hardware_command_queue
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY
  WITH cte AS (
    SELECT id FROM public.hardware_command_queue
    WHERE org_id = p_org_id
      AND status IN ('pending','failed')
      AND attempts < max_attempts
      AND (p_branch_id IS NULL OR branch_id IS NULL OR branch_id = p_branch_id)
    ORDER BY created_at
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  )
  UPDATE public.hardware_command_queue q
  SET status = 'running',
      attempts = q.attempts + 1,
      claimed_by = p_claimant,
      claimed_at = now()
  FROM cte
  WHERE q.id = cte.id
  RETURNING q.*;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_next_hardware_command(uuid, text, int, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_next_hardware_command(uuid, text, int, uuid) TO authenticated, service_role;

-- Drop the old 3-arg signature so the new branch-aware one is canonical.
DROP FUNCTION IF EXISTS public.claim_next_hardware_command(uuid, text, int);

COMMENT ON FUNCTION public.claim_next_hardware_command(uuid, text, int, uuid)
  IS 'Branch-aware claim. NULL p_branch_id falls back to org-wide (legacy behaviour). Commands with NULL branch_id are always eligible (org-scoped commands).';
