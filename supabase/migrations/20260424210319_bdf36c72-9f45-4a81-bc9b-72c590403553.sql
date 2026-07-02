CREATE OR REPLACE FUNCTION public.set_updated_at_integration()
RETURNS TRIGGER LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

CREATE OR REPLACE FUNCTION public.recompute_integration_next_run()
RETURNS TRIGGER LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NEW.auto_refresh_enabled AND NEW.is_active THEN
    NEW.next_run_at := COALESCE(NEW.last_run_at, now()) + (NEW.auto_refresh_interval_hours || ' hours')::interval;
  ELSE
    NEW.next_run_at := NULL;
  END IF;
  RETURN NEW;
END $$;