CREATE OR REPLACE FUNCTION public._mirror_approval_to_rfq()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_rfq public.rfqs;
  v_actor uuid;
BEGIN
  -- Single canonical engine: this mirror is how governance decisions reach
  -- the RFQ module. Do NOT add a second approval engine for purchasing.
  IF NEW.entity_type <> 'rfq' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_rfq FROM public.rfqs WHERE id = NEW.entity_id;
  IF v_rfq.id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT h.actor_user_id INTO v_actor
    FROM public.approval_history h
   WHERE h.request_id = NEW.id AND h.actor_user_id IS NOT NULL
   ORDER BY h.created_at DESC
   LIMIT 1;
  v_actor := COALESCE(auth.uid(), v_actor);

  IF NEW.status = 'approved' AND v_rfq.status = 'pending_approval' THEN
    UPDATE public.rfqs
       SET status = 'approved',
           approved_by = v_actor,
           approved_at = now(),
           approval_request_id = NEW.id,
           updated_at = now()
     WHERE id = v_rfq.id;
    PERFORM public._rfq_emit(v_rfq, 'rfq.approved',
      jsonb_build_object('approval_request_id', NEW.id), v_actor);
  ELSIF NEW.status IN ('rejected','cancelled') AND v_rfq.status = 'pending_approval' THEN
    UPDATE public.rfqs
       SET status = 'draft',
           submitted_by = NULL,
           submitted_at = NULL,
           approval_request_id = NULL,
           updated_at = now()
     WHERE id = v_rfq.id;
    PERFORM public._rfq_emit(v_rfq, 'rfq.rejected',
      jsonb_build_object('approval_request_id', NEW.id, 'status', NEW.status), v_actor);
  END IF;

  RETURN NEW;
END;
$function$;