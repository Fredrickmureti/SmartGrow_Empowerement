-- Enable pg_net for HTTP calls from triggers
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- Entity type to table name mapping is handled implicitly:
-- The trigger knows its own table and we map table -> entity_type in the function.

CREATE OR REPLACE FUNCTION public.notify_automation_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _record RECORD;
  _old_record RECORD;
  _trigger_type TEXT;
  _org_id UUID;
  _record_id UUID;
  _entity_type TEXT;
  _changed_fields TEXT[];
  _supabase_url TEXT;
  _anon_key TEXT;
  _payload JSONB;
  _has_automations BOOLEAN;
BEGIN
  -- Determine trigger type
  IF TG_OP = 'INSERT' THEN
    _trigger_type := 'on_create';
    _record := NEW;
    _org_id := NEW.organization_id;
    _record_id := NEW.id;
  ELSIF TG_OP = 'UPDATE' THEN
    _trigger_type := 'on_update';
    _record := NEW;
    _old_record := OLD;
    _org_id := NEW.organization_id;
    _record_id := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    _trigger_type := 'on_delete';
    _record := OLD;
    _org_id := OLD.organization_id;
    _record_id := OLD.id;
  END IF;

  -- Map table name to entity type
  _entity_type := CASE TG_TABLE_NAME
    WHEN 'invoices' THEN 'invoice'
    WHEN 'contacts' THEN 'contact'
    WHEN 'products' THEN 'product'
    WHEN 'estimates' THEN 'estimate'
    WHEN 'sales_orders' THEN 'sales_order'
    WHEN 'purchase_orders' THEN 'purchase_order'
    WHEN 'bills' THEN 'bill'
    WHEN 'expenses' THEN 'expense'
    WHEN 'projects' THEN 'project'
    WHEN 'crm_leads' THEN 'crm_lead'
    WHEN 'employees' THEN 'employee'
    ELSE TG_TABLE_NAME
  END;

  -- Quick check: are there any active automations for this entity+trigger in this org?
  SELECT EXISTS(
    SELECT 1 FROM public.automated_actions
    WHERE organization_id = _org_id
      AND target_model = _entity_type
      AND is_active = true
      AND is_circuit_broken = false
      AND trigger_type IN (_trigger_type, 'field_change')
  ) INTO _has_automations;

  -- If no automations match, return early (no HTTP call overhead)
  IF NOT _has_automations THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  -- For UPDATE, detect changed fields
  IF TG_OP = 'UPDATE' THEN
    _changed_fields := ARRAY(
      SELECT key FROM jsonb_each(to_jsonb(NEW)) AS n(key, val)
      WHERE to_jsonb(OLD) ->> key IS DISTINCT FROM to_jsonb(NEW) ->> key
    );
  END IF;

  -- Build payload
  _payload := jsonb_build_object(
    'trigger_type', _trigger_type,
    'target_model', _entity_type,
    'record_id', _record_id::text,
    'organization_id', _org_id::text,
    'changed_fields', COALESCE(to_jsonb(_changed_fields), '[]'::jsonb)
  );

  -- Call edge function via pg_net
  _supabase_url := current_setting('app.settings.supabase_url', true);
  _anon_key := current_setting('app.settings.anon_key', true);
  
  -- Fallback to hardcoded URL if settings not available
  IF _supabase_url IS NULL OR _supabase_url = '' THEN
    _supabase_url := 'https://jkszmrroyjfdwokbkzis.supabase.co';
  END IF;
  IF _anon_key IS NULL OR _anon_key = '' THEN
    _anon_key := 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imprc3ptcnJveWpmZHdva2JremlzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc4MzkwMzEsImV4cCI6MjA4MzQxNTAzMX0.iJjPAh8zaed1XbgKnRZp63JLNU37Z72CJPHlSnEPaQc';
  END IF;

  PERFORM extensions.http_post(
    url := _supabase_url || '/functions/v1/process-event-automations',
    body := _payload::text,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || _anon_key
    )::text
  );

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;

EXCEPTION WHEN OTHERS THEN
  -- Never let automation trigger failures block the actual operation
  RAISE WARNING 'Automation trigger failed: %', SQLERRM;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

-- Attach triggers to entity tables
DO $$
DECLARE
  _tables TEXT[] := ARRAY['invoices', 'contacts', 'products', 'estimates', 'sales_orders', 'purchase_orders', 'bills', 'expenses', 'projects', 'crm_leads', 'employees'];
  _tbl TEXT;
BEGIN
  FOREACH _tbl IN ARRAY _tables LOOP
    -- Drop existing trigger if any
    EXECUTE format('DROP TRIGGER IF EXISTS trg_automation_event ON public.%I', _tbl);
    -- Create trigger
    EXECUTE format(
      'CREATE TRIGGER trg_automation_event AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.notify_automation_event()',
      _tbl
    );
  END LOOP;
END;
$$;