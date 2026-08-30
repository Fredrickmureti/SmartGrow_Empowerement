-- Last plan-table dependency in access control; no callers remain in the app
-- or in other database functions.
DROP FUNCTION IF EXISTS public.check_org_usage_limit(uuid, text, integer);