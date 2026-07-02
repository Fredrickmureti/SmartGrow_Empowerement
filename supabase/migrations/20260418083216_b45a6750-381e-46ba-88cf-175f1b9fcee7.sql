
-- 1) Fix the ambiguous "key" reference in the automation processor trigger.
-- The FULL OUTER JOIN exposes two "key" columns (n.key and o.key); aggregate
-- on the coalesced value so updates don't crash.
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
BEGIN
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

  CASE TG_OP
    WHEN 'INSERT' THEN event_type := 'on_create';
    WHEN 'UPDATE' THEN event_type := 'on_update';
    WHEN 'DELETE' THEN event_type := 'on_delete';
    ELSE event_type := lower(TG_OP);
  END CASE;

  IF TG_OP = 'DELETE' THEN
    org_id := OLD.organization_id::text;
    rec_id := OLD.id::text;
  ELSE
    org_id := NEW.organization_id::text;
    rec_id := NEW.id::text;
  END IF;

  IF org_id IS NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  changed_fields := '[]'::jsonb;
  IF TG_OP = 'UPDATE' THEN
    SELECT COALESCE(jsonb_agg(field_name), '[]'::jsonb) INTO changed_fields
    FROM (
      SELECT COALESCE(n.key, o.key) AS field_name
      FROM jsonb_each_text(to_jsonb(NEW)) AS n(key, val)
      FULL OUTER JOIN jsonb_each_text(to_jsonb(OLD)) AS o(key, val) ON n.key = o.key
      WHERE n.val IS DISTINCT FROM o.val
    ) changed;
  END IF;

  payload := jsonb_build_object(
    'event_type', event_type,
    'target_model', TG_TABLE_NAME,
    'record_id', rec_id,
    'record_data', record_data,
    'old_data', old_record_data,
    'changed_fields', changed_fields,
    'organization_id', org_id
  );

  edge_function_url := rtrim(current_setting('app.settings.supabase_url', true), '/') || '/functions/v1/process-automation';
  anon_key := current_setting('app.settings.supabase_anon_key', true);

  IF edge_function_url IS NULL OR edge_function_url = '' OR edge_function_url = '/functions/v1/process-automation' THEN
    edge_function_url := 'https://jkszmrroyjfdwokbkzis.supabase.co/functions/v1/process-automation';
  END IF;

  IF anon_key IS NULL OR anon_key = '' THEN
    anon_key := 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imprc3ptcnJveWpmZHdva2JremlzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc4MzkwMzEsImV4cCI6MjA4MzQxNTAzMX0.iJjPAh8zaed1XbgKnRZp63JLNU37Z72CJPHlSnEPaQc';
  END IF;

  PERFORM net.http_post(
    url := edge_function_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || anon_key
    ),
    body := payload
  );

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  ELSE
    RETURN NEW;
  END IF;
END;
$function$;

-- 2) Remediation: reverse duplicate JE-00003 for Boma Net Solutions (BILL-00001)
DO $$
DECLARE
  _org_id uuid := '0a1691f2-1d76-430d-809c-68955e560ec7';
  _business_id uuid := '2b53875f-805f-4e4e-a770-d7971314501d';
  _user_id uuid := '4cf18944-4250-4199-af49-94bf32541fa7';
  _orig_id uuid := '42f96ec9-bf96-4a34-a9a6-49792bf99bc0';
  _ap_id uuid := '00eb9a97-eaff-4951-b5ed-0dc5c54ff29e';
  _cogs_id uuid := 'daa837a3-953a-4f8f-a99e-cb67c8e8d357';
  _contact_id uuid := '14ce09c6-59fb-4918-8ad6-7255243de6a6';
  _reversal_id uuid := gen_random_uuid();
  _next_num text;
  _now timestamptz := now();
BEGIN
  SELECT 'JE-' || LPAD((COALESCE(MAX(NULLIF(regexp_replace(entry_number, '[^0-9]', '', 'g'), ''))::int, 0) + 1)::text, 5, '0')
  INTO _next_num
  FROM journal_entries
  WHERE organization_id = _org_id;

  INSERT INTO journal_entries (
    id, organization_id, business_id, entry_number, entry_date,
    description, status, posted_at, posted_by, created_by,
    source_type, source_id, is_reversal, is_reversing, reversed_entry_id,
    void_reason, created_at, updated_at
  ) VALUES (
    _reversal_id, _org_id, _business_id, _next_num, CURRENT_DATE,
    'Reversal of JE-00003: duplicate auto-posting of BILL-00001. JE-00004 is the canonical source-linked entry.',
    'posted', _now, _user_id, _user_id,
    'reversal', _orig_id, true, true, _orig_id,
    'Duplicate auto-posting of BILL-00001', _now, _now
  );

  INSERT INTO journal_entry_lines (journal_entry_id, account_id, description, debit, credit, contact_id, sort_order, created_at)
  VALUES
    (_reversal_id, _ap_id,   'VOID: Payable - Bill BILL-00001 (duplicate)', 5000, 0,    _contact_id, 0, _now),
    (_reversal_id, _cogs_id, 'VOID: Bill BILL-00001 (duplicate COGS)',      0,    5000, _contact_id, 1, _now);

  UPDATE accounts SET current_balance = COALESCE(current_balance,0) - 5000, updated_at = _now WHERE id = _ap_id;
  UPDATE accounts SET current_balance = COALESCE(current_balance,0) - 5000, updated_at = _now WHERE id = _cogs_id;

  UPDATE journal_entries
  SET status = 'voided',
      voided_at = _now,
      voided_by = _user_id,
      void_reason = 'Duplicate auto-posting of BILL-00001 — reversed by ' || _next_num,
      updated_at = _now
  WHERE id = _orig_id;
END $$;
