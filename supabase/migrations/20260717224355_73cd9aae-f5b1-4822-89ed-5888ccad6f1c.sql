CREATE OR REPLACE FUNCTION public.emit_pack_lifecycle_event()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_event text;
BEGIN
  v_event := CASE WHEN TG_OP = 'INSERT' THEN 'localization_pack.created'
                  ELSE 'localization_pack.updated' END;

  INSERT INTO public.business_event_outbox
    (org_id, event_type, source_doc_type, source_doc_id, payload, status, source, idempotency_key)
  VALUES
    (COALESCE(NEW.publisher_org_id, '00000000-0000-0000-0000-000000000000'::uuid),
     v_event, 'localization_pack', NEW.id,
     jsonb_build_object(
       'pack_id', NEW.id,
       'name', NEW.name,
       'version', NEW.version,
       'country_code', NEW.country_code,
       'publisher_kind', NEW.publisher_kind,
       'is_published', NEW.is_published
     ),
     'pending'::business_event_status, 'system',
     v_event || ':' || NEW.id::text || ':' || COALESCE(NEW.version::text, 'v'))
  ON CONFLICT (org_id, idempotency_key) DO NOTHING;

  RETURN NEW;
END;
$function$;