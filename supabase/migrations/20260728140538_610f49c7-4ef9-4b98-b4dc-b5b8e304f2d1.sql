DO $$
DECLARE
  v_id uuid;
BEGIN
  SELECT id INTO v_id FROM vault.secrets WHERE name = 'cron_caller_jwt';
  IF v_id IS NULL THEN
    PERFORM vault.create_secret('f396e5e7f0f063daf4915b83e97626699d5cdcc11a09ff65234904a5f4503bd7', 'cron_caller_jwt', 'Shared token used by pg_cron to call edge functions');
  ELSE
    PERFORM vault.update_secret(v_id, 'f396e5e7f0f063daf4915b83e97626699d5cdcc11a09ff65234904a5f4503bd7');
  END IF;
END $$;