CREATE OR REPLACE FUNCTION public.emit_return_state_change_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  INSERT INTO public.business_event_outbox
    (org_id, event_type, source_doc_type, source_doc_id, payload, status, source, idempotency_key, actor_user_id)
  VALUES
    (
      NEW.organization_id,
      'return.state_changed',
      'payroll_return_run',
      NEW.run_id,
      jsonb_build_object(
        'run_id', NEW.run_id,
        'business_id', NEW.business_id,
        'from_status', NEW.from_status,
        'to_status', NEW.to_status,
        'reason', NEW.reason,
        'audit_id', NEW.id,
        'emitter', 'payroll_return_state_machine'
      ),
      'pending',
      'system',
      'return.state:' || NEW.id::text,
      NEW.actor_user_id
    );
  RETURN NEW;
END;
$function$;