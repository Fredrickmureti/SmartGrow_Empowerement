
-- P2.2: Atomic daily counter increment function
CREATE OR REPLACE FUNCTION public.sms_increment_daily_counter(config_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  current_count integer;
  today_str text := to_char(now(), 'YYYY-MM-DD');
BEGIN
  UPDATE sms_provider_configs
  SET
    messages_sent_today = CASE
      WHEN last_reset_date = today_str THEN messages_sent_today + 1
      ELSE 1
    END,
    last_reset_date = today_str
  WHERE id = config_id
  RETURNING messages_sent_today INTO current_count;
  
  RETURN current_count;
END;
$$;
