-- ─────────────────────────────────────────────────────────────────────────────
-- Reporting authorization: branch access + financials module read.
--
-- The reporting RPCs are SECURITY DEFINER, so RLS on journal_entries /
-- journal_entry_lines / accounts does not apply to them and they must
-- reproduce its rules themselves. They already enforced organization and
-- business scope via finance_can_read_scope, but for branches they only
-- validated OWNERSHIP (the branch belongs to the org/business) — never
-- ACCESS. RLS on the same tables requires user_can_access_branch(...) OR the
-- finance.view_consolidated permission, so a branch-confined user could pass
-- a sibling branch's id to get_account_movements and receive its figures.
-- They also skipped the financials:read module permission that the RLS
-- policies require.
-- ─────────────────────────────────────────────────────────────────────────────

-- Branch-level read gate for the reporting RPCs.
--   _branch_id NOT NULL → the caller must be able to access that branch.
--   _branch_id NULL     → an all-branches request. Allowed for service_role,
--                         for holders of finance.view_consolidated, and for
--                         callers with no branch assignment inside the scoped
--                         business(es) (head-office access). A branch-confined
--                         caller must name their branch explicitly.
CREATE OR REPLACE FUNCTION public.finance_can_read_branch(
  _org_id uuid,
  _business_id uuid,
  _branch_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT
    -- Trusted server-side callers (edge functions, scheduled reports).
    COALESCE(
      NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
      current_user
    ) = 'service_role'
    OR (
      auth.uid() IS NOT NULL
      AND CASE
        WHEN _branch_id IS NOT NULL
          THEN public.user_can_access_branch(auth.uid(), _branch_id)
        ELSE
          public.has_finance_permission(auth.uid(), 'finance.view_consolidated', _business_id)
          OR NOT EXISTS (
            SELECT 1
            FROM public.user_branch_assignments uba
            JOIN public.branches b ON b.id = uba.branch_id
            WHERE uba.user_id = auth.uid()
              AND b.organization_id = _org_id
              AND (_business_id IS NULL OR b.business_id = _business_id)
          )
      END
    );
$function$;

REVOKE ALL ON FUNCTION public.finance_can_read_branch(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.finance_can_read_branch(uuid, uuid, uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.finance_can_read_branch(uuid, uuid, uuid) IS
  'Branch-level read gate for the SECURITY DEFINER reporting RPCs. Mirrors the branch leg of the journal_entries / journal_entry_lines RLS policies, which those RPCs bypass.';

-- Financials module read gate, mirroring the module leg of the RLS policies on
-- accounts and journal_entries.
CREATE OR REPLACE FUNCTION public.finance_can_read_financials(
  _org_id uuid,
  _business_id uuid
)
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
      AND (
        _business_id IS NULL
        OR public.user_has_module_permission(
             auth.uid(), _org_id, _business_id, 'financials', 'read'
           )
      )
    );
$function$;

REVOKE ALL ON FUNCTION public.finance_can_read_financials(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.finance_can_read_financials(uuid, uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.finance_can_read_financials(uuid, uuid) IS
  'Financials module read gate for the SECURITY DEFINER reporting RPCs, mirroring the module_permission leg of the accounts / journal_entries RLS policies.';

-- Inject both gates into every reporting RPC, in place, by extending the
-- single scope check they all share. Patching the existing definitions (rather
-- than restating five long bodies) keeps their aggregation logic byte-identical
-- and makes drift impossible.
DO $do$
DECLARE
  r record;
  v_def text;
  v_new text;
  v_count int := 0;
  v_old_token text := 'IF NOT public.finance_can_read_scope(_org_id, _business_id) THEN';
  v_new_token text :=
    'IF NOT public.finance_can_read_scope(_org_id, _business_id)'
    || E'\n     OR NOT public.finance_can_read_branch(_org_id, _business_id, _branch_id)'
    || E'\n     OR NOT public.finance_can_read_financials(_org_id, _business_id) THEN';
BEGIN
  FOR r IN
    SELECT p.oid, p.proname
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN (
         'get_account_movements',
         'get_ledger_opening_balances',
         'get_equity_result',
         'get_general_ledger',
         'get_journal_report'
       )
  LOOP
    v_def := pg_get_functiondef(r.oid);

    -- Idempotency: skip anything already carrying the branch gate.
    IF position('finance_can_read_branch' IN v_def) > 0 THEN
      CONTINUE;
    END IF;

    IF position(v_old_token IN v_def) = 0 THEN
      RAISE EXCEPTION
        'finance reporting gate: % does not contain the expected scope check; refusing to patch blindly',
        r.proname;
    END IF;

    v_new := replace(v_def, v_old_token, v_new_token);
    EXECUTE v_new;
    v_count := v_count + 1;
  END LOOP;

  IF v_count <> 5 THEN
    RAISE EXCEPTION 'finance reporting gate: expected to patch 5 functions, patched %', v_count;
  END IF;
END
$do$;