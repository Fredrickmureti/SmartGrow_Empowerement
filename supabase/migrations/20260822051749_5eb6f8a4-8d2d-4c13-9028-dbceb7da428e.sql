CREATE OR REPLACE FUNCTION public.finance_can_read_scope(_org_id uuid, _business_id uuid DEFAULT NULL::uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT
    COALESCE(
      NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
      current_user
    ) = 'service_role'
    OR (
      auth.uid() IS NOT NULL
      AND public.is_org_member(auth.uid(), _org_id)
      AND (
        CASE
          WHEN _business_id IS NOT NULL
            THEN public.user_can_access_business(auth.uid(), _business_id)
          -- Org-wide (unscoped) run: only for a caller who can reach every
          -- active business in the organization. Otherwise an aggregate would
          -- silently include businesses the caller is not entitled to.
          ELSE NOT EXISTS (
            SELECT 1 FROM public.businesses b
             WHERE b.organization_id = _org_id
               AND b.is_active = true
               AND NOT public.user_can_access_business(auth.uid(), b.id)
          )
        END
      )
    );
$function$;

REVOKE ALL ON FUNCTION public.finance_can_read_scope(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finance_can_read_scope(uuid, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.finance_can_read_scope(uuid, uuid) TO authenticated, service_role;

DO $mig$
DECLARE
  r record;
  src text;
  patched text;
  n int := 0;
BEGIN
  FOR r IN
    SELECT p.oid, p.proname
      FROM pg_proc p
      JOIN pg_namespace ns ON ns.oid = p.pronamespace
     WHERE ns.nspname = 'public'
       AND p.proname IN (
         'get_account_movements',
         'get_ledger_opening_balances',
         'get_general_ledger',
         'get_journal_report'
       )
  LOOP
    src := pg_get_functiondef(r.oid);
    patched := replace(
      src,
      'IF NOT public.finance_can_read_org(_org_id) THEN',
      'IF NOT public.finance_can_read_scope(_org_id, _business_id) THEN'
    );
    IF patched = src THEN
      RAISE EXCEPTION 'finance scope gate not found in %', r.proname;
    END IF;
    EXECUTE patched;
    n := n + 1;
  END LOOP;

  IF n <> 4 THEN
    RAISE EXCEPTION 'expected 4 reporting functions, patched %', n;
  END IF;
END
$mig$;