-- Linter 0011: pin the search_path on the helper added in the previous
-- migration so it matches the standard used by every reporting function.
CREATE OR REPLACE FUNCTION public._raise_business_required()
RETURNS uuid
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'public'
AS $$
BEGIN
  RAISE EXCEPTION 'INVENTORY_REPORT_BUSINESS_REQUIRED: a company is required'
    USING ERRCODE = '22023';
END;
$$;

REVOKE ALL ON FUNCTION public._raise_business_required() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._raise_business_required() TO authenticated, service_role;