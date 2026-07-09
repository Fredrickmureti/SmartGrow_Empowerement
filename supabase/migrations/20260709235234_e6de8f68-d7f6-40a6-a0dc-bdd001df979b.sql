CREATE OR REPLACE FUNCTION public._physical_count_post_side_effects()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_released int;
BEGIN
  IF NEW.state = 'posted' AND (OLD.state IS DISTINCT FROM 'posted') THEN
    v_released := public._release_physical_count_reservations(NEW.id);

    INSERT INTO public.business_event_outbox (
      org_id,
      branch_id,
      event_type,
      source_doc_type,
      source_doc_id,
      payload,
      status,
      source,
      actor_user_id,
      idempotency_key
    ) VALUES (
      NEW.organization_id,
      NEW.branch_id,
      'inventory.reorder.recompute',
      'physical_count',
      NEW.id,
      jsonb_build_object(
        'business_id', NEW.business_id,
        'warehouse_id', NEW.warehouse_id,
        'count_id', NEW.id
      ),
      'pending'::public.business_event_status,
      'system',
      NEW.posted_by,
      'inventory.reorder.recompute:physical_count:' || NEW.id::text
    )
    ON CONFLICT (org_id, idempotency_key) DO NOTHING;

    INSERT INTO public.physical_count_events (count_id, organization_id, event_type, actor_id, payload)
    VALUES (
      NEW.id,
      NEW.organization_id,
      'reservations_released',
      NEW.posted_by,
      jsonb_build_object('released', v_released)
    );
  ELSIF NEW.state = 'cancelled' AND (OLD.state IS DISTINCT FROM 'cancelled') THEN
    v_released := public._release_physical_count_reservations(NEW.id);

    INSERT INTO public.physical_count_events (count_id, organization_id, event_type, actor_id, payload)
    VALUES (
      NEW.id,
      NEW.organization_id,
      'reservations_released',
      NEW.cancelled_by,
      jsonb_build_object('released', v_released, 'reason', 'cancelled')
    );
  END IF;

  RETURN NEW;
END
$function$;