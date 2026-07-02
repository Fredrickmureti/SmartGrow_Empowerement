CREATE OR REPLACE FUNCTION public.sms_increment_daily_counter(config_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  current_count integer;
BEGIN
  UPDATE sms_provider_configs
  SET
    messages_sent_today = CASE
      WHEN last_reset_date = current_date THEN messages_sent_today + 1
      ELSE 1
    END,
    last_reset_date = current_date
  WHERE id = config_id
  RETURNING messages_sent_today INTO current_count;

  RETURN current_count;
END;
$function$;