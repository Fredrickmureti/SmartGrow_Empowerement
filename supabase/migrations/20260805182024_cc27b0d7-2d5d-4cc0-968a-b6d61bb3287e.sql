INSERT INTO public.business_event_topics (topic_prefix, producer_domain, consumer_domains, handler_scope, description)
VALUES (
  'label.',
  'inventory',
  ARRAY['inventory','warehouse','analytics'],
  'server',
  'Label lifecycle: demand raised by business events, and label run submitted/completed/failed.'
)
ON CONFLICT (topic_prefix) DO UPDATE
  SET producer_domain = EXCLUDED.producer_domain,
      consumer_domains = EXCLUDED.consumer_domains,
      description = EXCLUDED.description,
      updated_at = now();

-- Emit label.run.* business events so the run engine participates in the event fabric.
CREATE OR REPLACE FUNCTION public._label_run_emit_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_topic text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_topic := 'label.run.submitted';
  ELSIF NEW.status IS DISTINCT FROM OLD.status
        AND NEW.status IN ('completed','failed','cancelled') THEN
    v_topic := 'label.run.' || NEW.status::text;
  ELSE
    RETURN NEW;
  END IF;

  INSERT INTO public.business_event_outbox (
    business_id, topic, aggregate_type, aggregate_id, payload
  ) VALUES (
    NEW.business_id,
    v_topic,
    'label_print_run',
    NEW.id,
    jsonb_build_object(
      'run_id', NEW.id,
      'template_key', NEW.template_key,
      'entity_type', NEW.entity_type,
      'status', NEW.status,
      'total_lines', NEW.total_lines,
      'printed_lines', NEW.printed_lines,
      'failed_lines', NEW.failed_lines,
      'refused_lines', NEW.refused_lines
    )
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_label_run_emit_event ON public.label_print_runs;
CREATE TRIGGER trg_label_run_emit_event
AFTER INSERT OR UPDATE OF status ON public.label_print_runs
FOR EACH ROW EXECUTE FUNCTION public._label_run_emit_event();