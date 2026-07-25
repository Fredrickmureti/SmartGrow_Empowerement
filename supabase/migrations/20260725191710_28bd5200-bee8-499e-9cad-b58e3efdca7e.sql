
-- ============================================================
-- Phase 4.2 — retire the client-side approval gate
-- ============================================================

INSERT INTO public.governance_action_registry(
  action_key, module, subject_table, subject_mode, label, description,
  severity_default, is_active, requires_approval_always
) VALUES (
  'procurement_recommendation.approve', 'Purchasing',
  'procurement_recommendations', 'actor',
  'Approve replenishment recommendation',
  'Approve a suggested purchase so it can be converted into a purchase order.',
  'standard', true, false
)
ON CONFLICT (action_key) DO UPDATE
  SET module = EXCLUDED.module,
      subject_table = EXCLUDED.subject_table,
      is_active = true;

-- Mirror engine decisions back onto the recommendation row.
CREATE OR REPLACE FUNCTION public._exec_procurement_recommendation_approval()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_from text;
BEGIN
  IF NEW.entity_type <> 'procurement_recommendation' THEN RETURN NEW; END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'pending' THEN
      UPDATE public.procurement_recommendations
         SET status = 'in_review', approval_request_id = NEW.id, updated_at = now()
       WHERE id = NEW.entity_id AND status IN ('open','in_review');
      PERFORM public.log_procurement_recommendation_event(
        NEW.entity_id, 'approval_requested', NULL, 'in_review',
        jsonb_build_object('approval_request_id', NEW.id), NEW.notes);
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;

  SELECT status INTO v_from FROM public.procurement_recommendations WHERE id = NEW.entity_id;

  IF NEW.status = 'approved' THEN
    UPDATE public.procurement_recommendations
       SET status = 'approved', updated_at = now()
     WHERE id = NEW.entity_id AND approval_request_id = NEW.id;
    PERFORM public.log_procurement_recommendation_event(
      NEW.entity_id, 'approval_granted', v_from, 'approved',
      jsonb_build_object('approval_request_id', NEW.id), NEW.notes);
  ELSIF NEW.status IN ('rejected','denied','cancelled','canceled') THEN
    UPDATE public.procurement_recommendations
       SET status = 'open', approval_request_id = NULL, updated_at = now()
     WHERE id = NEW.entity_id AND approval_request_id = NEW.id;
    PERFORM public.log_procurement_recommendation_event(
      NEW.entity_id, 'approval_rejected', v_from, 'open',
      jsonb_build_object('approval_request_id', NEW.id), NEW.notes);
  END IF;

  RETURN NEW;
END$$;

DROP TRIGGER IF EXISTS trg_exec_procurement_rec_approval_ins ON public.approval_requests;
CREATE TRIGGER trg_exec_procurement_rec_approval_ins
  AFTER INSERT ON public.approval_requests
  FOR EACH ROW EXECUTE FUNCTION public._exec_procurement_recommendation_approval();

DROP TRIGGER IF EXISTS trg_exec_procurement_rec_approval_upd ON public.approval_requests;
CREATE TRIGGER trg_exec_procurement_rec_approval_upd
  AFTER UPDATE OF status ON public.approval_requests
  FOR EACH ROW EXECUTE FUNCTION public._exec_procurement_recommendation_approval();

-- The legacy ledger becomes read-only to the app. SECURITY DEFINER routines
-- (stock adjustment RPCs) still write to it until their own migration lands.
REVOKE INSERT, UPDATE, DELETE ON public.approval_rule_logs FROM authenticated, anon;
