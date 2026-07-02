CREATE OR REPLACE FUNCTION public.sync_contract_to_employee()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  -- Contract is the source of truth for compensation (wage, housing/transport
  -- allowances). The employees table only mirrors `other_allowances` and
  -- bumps updated_at when a contract is activated, so downstream consumers
  -- (payroll, exports) refresh their cached employee snapshot.
  IF NEW.status = 'running' AND (OLD.status IS NULL OR OLD.status <> 'running') THEN
    UPDATE public.employees
    SET
      other_allowances = COALESCE(NEW.other_allowances, '{}'::jsonb),
      updated_at = now()
    WHERE id = NEW.employee_id;
  END IF;
  RETURN NEW;
END;
$function$;