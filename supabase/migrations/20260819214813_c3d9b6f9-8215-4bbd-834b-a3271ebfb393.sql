-- Recognise trusted internal callers correctly.
--
-- Previously this checked session_user only. Under PostgREST the session user
-- is always the connection role ('authenticator'), and the effective role is
-- carried in the JWT, so server-side report generation running with the
-- service role was misclassified as an untrusted browser caller and failed
-- _assert_org_member() with 'Not authenticated'.
--
-- Trusted = direct database sessions (migrations, pgTAP self-tests, read-only
-- admin tooling) OR a request whose JWT role is service_role. Requests with
-- role 'anon' / 'authenticated' are never trusted and remain subject to the
-- full org + business + branch authorization checks.
CREATE OR REPLACE FUNCTION public._is_trusted_inventory_diag_context()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
  SELECT
    session_user IN ('postgres', 'supabase_admin', 'supabase_read_only_user')
    OR COALESCE(
         (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb) ->> 'role',
         ''
       ) = 'service_role';
$$;