-- Drop the orphaned 5-arg overload that conflicts with the 6-arg superset.
DROP FUNCTION IF EXISTS public.assert_payroll_ready(uuid, uuid, uuid[], date, date);

-- Re-affirm grants on the surviving overload (idempotent).
GRANT EXECUTE ON FUNCTION public.assert_payroll_ready(uuid, uuid, uuid[], date, date, uuid)
  TO authenticated, service_role;