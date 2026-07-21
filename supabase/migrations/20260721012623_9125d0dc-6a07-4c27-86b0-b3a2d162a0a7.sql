-- ADR-0087 hardening: guarantee the resolver is idempotent to redeploy
-- and locked down to the roles that can call it. The Phase-13 migration
-- shipped CREATE OR REPLACE only; this migration adds the missing
-- lifecycle guards so a fresh clone builds identically to prod.

-- 1. Drop the legacy 3-arg signature first (idempotent redeploy).
DROP FUNCTION IF EXISTS public.resolve_label_template(uuid, text, uuid);

-- 2. Revoke from PUBLIC and grant only to the roles the app uses.
--    The function is SECURITY DEFINER, so PUBLIC EXECUTE would let
--    anyone with a valid JWT bypass RLS on label_templates.
REVOKE ALL ON FUNCTION public.resolve_label_template(uuid, text, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_label_template(uuid, text, uuid, uuid) TO authenticated, service_role;
