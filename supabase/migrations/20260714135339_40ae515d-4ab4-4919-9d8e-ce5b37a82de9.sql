
-- Mirror approval_rule_logs decisions onto procurement_recommendations.
-- When an approval log row for entity_type='procurement_recommendation'
-- transitions to approved/rejected, promote or reset the recommendation.
CREATE OR REPLACE FUNCTION public._mirror_approval_to_procurement_rec()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rec_id uuid;
  v_from_status text;
BEGIN
  IF NEW.entity_type <> 'procurement_recommendation' THEN
    RETURN NEW;
  END IF;

  -- entity_id is text in approval_rule_logs; procurement_recommendations.id is uuid.
  BEGIN
    v_rec_id := NEW.entity_id::uuid;
  EXCEPTION WHEN others THEN
    RETURN NEW;
  END;

  IF (TG_OP = 'INSERT' AND NEW.status = 'pending')
     OR (TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status AND NEW.status = 'pending') THEN
    UPDATE public.procurement_recommendations
       SET status = 'in_review',
           approval_request_id = NEW.id,
           updated_at = now()
     WHERE id = v_rec_id
       AND status IN ('open', 'in_review');
    PERFORM public.log_procurement_recommendation_event(
      v_rec_id, 'approval_requested', NULL, 'in_review',
      jsonb_build_object('approval_log_id', NEW.id, 'rule_id', NEW.rule_id),
      NEW.notes
    );
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status AND NEW.status = 'approved' THEN
    SELECT status INTO v_from_status FROM public.procurement_recommendations WHERE id = v_rec_id;
    UPDATE public.procurement_recommendations
       SET status = 'approved',
           updated_at = now()
     WHERE id = v_rec_id
       AND approval_request_id = NEW.id;
    PERFORM public.log_procurement_recommendation_event(
      v_rec_id, 'approval_granted', v_from_status, 'approved',
      jsonb_build_object('approval_log_id', NEW.id, 'approved_by', NEW.approved_by),
      NEW.notes
    );
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status AND NEW.status = 'rejected' THEN
    SELECT status INTO v_from_status FROM public.procurement_recommendations WHERE id = v_rec_id;
    UPDATE public.procurement_recommendations
       SET status = 'open',
           approval_request_id = NULL,
           updated_at = now()
     WHERE id = v_rec_id
       AND approval_request_id = NEW.id;
    PERFORM public.log_procurement_recommendation_event(
      v_rec_id, 'approval_rejected', v_from_status, 'open',
      jsonb_build_object('approval_log_id', NEW.id, 'rejected_by', NEW.rejected_by),
      NEW.notes
    );
    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS mirror_approval_to_procurement_rec ON public.approval_rule_logs;
CREATE TRIGGER mirror_approval_to_procurement_rec
AFTER INSERT OR UPDATE ON public.approval_rule_logs
FOR EACH ROW EXECUTE FUNCTION public._mirror_approval_to_procurement_rec();

-- Cancel a pending procurement approval. Deletes the log row and returns the
-- rec to 'open'. Only the requester (or someone with business access) may cancel.
CREATE OR REPLACE FUNCTION public.cancel_procurement_approval(p_rec_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_biz uuid;
  v_log_id uuid;
BEGIN
  SELECT business_id, approval_request_id INTO v_biz, v_log_id
    FROM public.procurement_recommendations WHERE id = p_rec_id;
  IF v_biz IS NULL OR NOT public.user_can_access_business(auth.uid(), v_biz) THEN
    RAISE EXCEPTION 'Access denied';
  END IF;
  IF v_log_id IS NULL THEN
    RAISE EXCEPTION 'Recommendation has no pending approval';
  END IF;

  DELETE FROM public.approval_rule_logs
   WHERE id = v_log_id AND status = 'pending';

  UPDATE public.procurement_recommendations
     SET status = 'open', approval_request_id = NULL, updated_at = now()
   WHERE id = p_rec_id;

  PERFORM public.log_procurement_recommendation_event(
    p_rec_id, 'approval_cancelled', 'in_review', 'open',
    jsonb_build_object('approval_log_id', v_log_id), NULL
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.cancel_procurement_approval(uuid) TO authenticated;
