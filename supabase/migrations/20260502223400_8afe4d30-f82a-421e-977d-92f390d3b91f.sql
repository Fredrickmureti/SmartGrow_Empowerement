CREATE OR REPLACE FUNCTION public.dispatch_notification_email()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, net
AS $$
DECLARE
  v_supabase_url TEXT;
  v_service_role_key TEXT;
BEGIN
  v_supabase_url := current_setting('app.settings.supabase_url', true);
  v_service_role_key := current_setting('app.settings.supabase_service_role_key', true);

  IF v_supabase_url IS NULL OR v_supabase_url = '' THEN
    v_supabase_url := 'https://jkszmrroyjfdwokbkzis.supabase.co';
  END IF;

  IF v_service_role_key IS NULL OR v_service_role_key = '' THEN
    v_service_role_key := current_setting('supabase.service_role_key', true);
  END IF;

  IF v_service_role_key IS NULL OR v_service_role_key = '' THEN
    BEGIN
      SELECT decrypted_secret INTO v_service_role_key
      FROM vault.decrypted_secrets
      WHERE name = 'supabase_service_role_key'
      LIMIT 1;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING '[dispatch_notification_email] Cannot access service role key, skipping email dispatch';
      RETURN NEW;
    END;
  END IF;

  IF v_service_role_key IS NULL OR v_service_role_key = '' THEN
    RAISE WARNING '[dispatch_notification_email] No service role key available, skipping email dispatch';
    RETURN NEW;
  END IF;

  PERFORM net.http_post(
    url := v_supabase_url || '/functions/v1/send-notification-email',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_service_role_key
    ),
    body := jsonb_build_object(
      'user_id', NEW.user_id,
      'organization_id', NEW.organization_id,
      'business_id', NEW.business_id,
      'category', NEW.category,
      'title', NEW.title,
      'message', NEW.message,
      'link', NEW.link,
      'entity_type', NEW.entity_type,
      'entity_id', NEW.entity_id,
      'notification_id', NEW.id
    )
  );

  RETURN NEW;
END;
$$;