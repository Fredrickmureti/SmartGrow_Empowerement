CREATE OR REPLACE FUNCTION public._label_run_emit_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_event text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_event := 'label.run.submitted';
  ELSIF NEW.status IS DISTINCT FROM OLD.status
        AND NEW.status::text IN ('completed','failed','cancelled') THEN
    v_event := 'label.run.' || NEW.status::text;
  ELSE
    RETURN NEW;
  END IF;

  INSERT INTO public.business_event_outbox (
    org_id, branch_id, warehouse_id, event_type,
    source_doc_type, source_doc_id, payload, idempotency_key, actor_user_id
  ) VALUES (
    NEW.organization_id,
    NEW.branch_id,
    NEW.warehouse_id,
    v_event,
    'label_print_run',
    NEW.id,
    jsonb_build_object(
      'run_id', NEW.id,
      'business_id', NEW.business_id,
      'template_key', NEW.template_key,
      'entity_type', NEW.entity_type,
      'status', NEW.status,
      'total_lines', NEW.total_lines,
      'printed_lines', NEW.printed_lines,
      'failed_lines', NEW.failed_lines,
      'refused_lines', NEW.refused_lines
    ),
    v_event || ':' || NEW.id::text,
    NEW.created_by
  )
  ON CONFLICT (idempotency_key) DO NOTHING;

  RETURN NEW;
END;
$$;