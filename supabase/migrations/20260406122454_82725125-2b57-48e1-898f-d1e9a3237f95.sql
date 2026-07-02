
-- Replace the broken pg_notify trigger function with pg_net HTTP POST
CREATE OR REPLACE FUNCTION public.trigger_automation_processor()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  payload jsonb;
  record_data jsonb;
  old_record_data jsonb;
  org_id text;
  event_type text;
  rec_id text;
  changed_fields jsonb;
  edge_function_url text;
  anon_key text;
  old_key text;
  new_val text;
BEGIN
  -- Build the record data based on operation
  IF TG_OP = 'DELETE' THEN
    record_data := to_jsonb(OLD);
    old_record_data := to_jsonb(OLD);
  ELSIF TG_OP = 'UPDATE' THEN
    record_data := to_jsonb(NEW);
    old_record_data := to_jsonb(OLD);
  ELSE
    record_data := to_jsonb(NEW);
    old_record_data := NULL;
  END IF;

  -- Map TG_OP to automation event_type
  CASE TG_OP
    WHEN 'INSERT' THEN event_type := 'on_create';
    WHEN 'UPDATE' THEN event_type := 'on_update';
    WHEN 'DELETE' THEN event_type := 'on_delete';
    ELSE event_type := lower(TG_OP);
  END CASE;

  -- Extract organization_id from the record
  IF TG_OP = 'DELETE' THEN
    org_id := OLD.organization_id::text;
    rec_id := OLD.id::text;
  ELSE
    org_id := NEW.organization_id::text;
    rec_id := NEW.id::text;
  END IF;

  -- Skip if no organization_id (safety)
  IF org_id IS NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  -- Compute changed fields for UPDATE operations
  changed_fields := '[]'::jsonb;
  IF TG_OP = 'UPDATE' THEN
    SELECT jsonb_agg(key) INTO changed_fields
    FROM (
      SELECT key
      FROM jsonb_each_text(to_jsonb(NEW)) AS n(key, val)
      FULL OUTER JOIN jsonb_each_text(to_jsonb(OLD)) AS o(key, val) ON n.key = o.key
      WHERE n.val IS DISTINCT FROM o.val
    ) changed;
    IF changed_fields IS NULL THEN
      changed_fields := '[]'::jsonb;
    END IF;
  END IF;

  -- Build payload matching the process-automation edge function interface
  payload := jsonb_build_object(
    'event_type', event_type,
    'target_model', TG_TABLE_NAME,
    'record_id', rec_id,
    'record_data', record_data,
    'old_data', old_record_data,
    'changed_fields', changed_fields,
    'organization_id', org_id
  );

  -- Construct the edge function URL
  edge_function_url := rtrim(current_setting('app.settings.supabase_url', true), '/') || '/functions/v1/process-automation';
  anon_key := current_setting('app.settings.supabase_anon_key', true);

  -- If app.settings are not configured, try the known project URL
  IF edge_function_url IS NULL OR edge_function_url = '' OR edge_function_url = '/functions/v1/process-automation' THEN
    edge_function_url := 'https://jkszmrroyjfdwokbkzis.supabase.co/functions/v1/process-automation';
  END IF;

  IF anon_key IS NULL OR anon_key = '' THEN
    anon_key := 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imprc3ptcnJveWpmZHdva2JremlzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc4MzkwMzEsImV4cCI6MjA4MzQxNTAzMX0.iJjPAh8zaed1XbgKnRZp63JLNU37Z72CJPHlSnEPaQc';
  END IF;

  -- Fire-and-forget HTTP POST via pg_net
  PERFORM net.http_post(
    url := edge_function_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || anon_key
    ),
    body := payload
  );

  -- Return appropriate value based on operation
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  ELSE
    RETURN NEW;
  END IF;
END;
$function$;
