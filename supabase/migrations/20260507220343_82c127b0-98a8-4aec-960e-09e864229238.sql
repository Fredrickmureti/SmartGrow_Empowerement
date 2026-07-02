-- Drop the obsolete 1-arg overload of assert_payroll_ready. Only the 5-arg
-- version (org, business, employees, period_start, period_end) should exist.
DROP FUNCTION IF EXISTS public.assert_payroll_ready(uuid);

-- Regression guard: a SECURITY DEFINER function that returns the list of
-- public functions whose body still references the dropped table. Tests/CI
-- can call this and assert the result is empty.
CREATE OR REPLACE FUNCTION public.__test_no_dropped_payroll_table_refs()
RETURNS TABLE(schema_name text, function_name text, args text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT n.nspname::text, p.proname::text, pg_get_function_identity_arguments(p.oid)::text
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname NOT IN ('pg_catalog','information_schema','pg_toast')
    AND pg_get_functiondef(p.oid) ~ '\mpayroll_account_mappings\M'
    -- Allow string literals containing the human label "payroll account mappings"
    AND pg_get_functiondef(p.oid) !~ '''payroll account mappings'''
$$;

REVOKE ALL ON FUNCTION public.__test_no_dropped_payroll_table_refs() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.__test_no_dropped_payroll_table_refs() TO authenticated, service_role;