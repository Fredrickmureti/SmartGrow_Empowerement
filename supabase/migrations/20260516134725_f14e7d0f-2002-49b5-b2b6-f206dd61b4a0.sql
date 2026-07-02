
-- ============================================================
-- Wave D: per-branch default account mapping (inherit + override)
-- ============================================================

-- 1. Add branch_id to mapping tables (NOT to accounts itself)
ALTER TABLE public.default_accounts
  ADD COLUMN IF NOT EXISTS branch_id uuid NULL REFERENCES public.branches(id) ON DELETE CASCADE;

ALTER TABLE public.default_account_settings
  ADD COLUMN IF NOT EXISTS branch_id uuid NULL REFERENCES public.branches(id) ON DELETE CASCADE;

-- 2. Replace old uniques with partial-index pairs that allow
--    company-default (branch_id NULL) + per-branch rows to coexist.
ALTER TABLE public.default_accounts
  DROP CONSTRAINT IF EXISTS default_accounts_business_id_purpose_key;
DROP INDEX IF EXISTS public.default_accounts_business_id_purpose_key;

CREATE UNIQUE INDEX IF NOT EXISTS uq_default_accounts_company
  ON public.default_accounts (business_id, purpose)
  WHERE branch_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_default_accounts_branch
  ON public.default_accounts (business_id, purpose, branch_id)
  WHERE branch_id IS NOT NULL;

ALTER TABLE public.default_account_settings
  DROP CONSTRAINT IF EXISTS uq_default_account_setting;
DROP INDEX IF EXISTS public.uq_default_account_setting;
ALTER TABLE public.default_account_settings
  DROP CONSTRAINT IF EXISTS uq_default_account_settings_biz_key;
DROP INDEX IF EXISTS public.uq_default_account_settings_biz_key;

CREATE UNIQUE INDEX IF NOT EXISTS uq_default_account_settings_company
  ON public.default_account_settings (organization_id, business_id, setting_key)
  WHERE branch_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_default_account_settings_branch
  ON public.default_account_settings (organization_id, business_id, setting_key, branch_id)
  WHERE branch_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_default_accounts_branch
  ON public.default_accounts (branch_id) WHERE branch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_default_account_settings_branch
  ON public.default_account_settings (branch_id) WHERE branch_id IS NOT NULL;

-- 3. Branch-aware resolver. Branch row wins over company row.
--    The existing 2-arg resolver keeps working (it now restricts to
--    branch_id IS NULL so callers that haven't been migrated keep
--    reading the company default — never a leaked branch override).
CREATE OR REPLACE FUNCTION public.resolve_default_account(
  p_business_id uuid,
  p_purpose text,
  p_branch_id uuid
) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_account_id uuid;
BEGIN
  IF p_branch_id IS NOT NULL THEN
    SELECT account_id INTO v_account_id
      FROM public.default_accounts
     WHERE business_id = p_business_id
       AND purpose = p_purpose
       AND branch_id = p_branch_id;
    IF v_account_id IS NOT NULL THEN RETURN v_account_id; END IF;
  END IF;

  -- Fall back to the company-wide (branch_id IS NULL) mapping,
  -- and then to the legacy 2-arg discovery heuristics.
  RETURN public.resolve_default_account(p_business_id, p_purpose);
END;
$$;

-- Rewrite the 2-arg resolver so it ONLY reads the company-default row
-- (branch_id IS NULL). Heuristic fallback retained.
CREATE OR REPLACE FUNCTION public.resolve_default_account(
  p_business_id uuid,
  p_purpose text
) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_account_id uuid;
  v_org_id uuid;
BEGIN
  SELECT account_id INTO v_account_id
    FROM public.default_accounts
   WHERE business_id = p_business_id
     AND purpose = p_purpose
     AND branch_id IS NULL;
  IF v_account_id IS NOT NULL THEN RETURN v_account_id; END IF;

  SELECT organization_id INTO v_org_id FROM public.businesses WHERE id = p_business_id;

  IF p_purpose = 'inventory' THEN
    SELECT id INTO v_account_id FROM public.accounts
     WHERE business_id = p_business_id AND organization_id = v_org_id
       AND is_active = true
       AND (detail_type = 'inventory' OR LOWER(name) LIKE '%inventory%' OR code LIKE '12%')
     ORDER BY (detail_type = 'inventory') DESC, code LIMIT 1;
  ELSIF p_purpose = 'inventory_adjustment' THEN
    SELECT id INTO v_account_id FROM public.accounts
     WHERE business_id = p_business_id AND organization_id = v_org_id
       AND is_active = true
       AND (detail_type IN ('inventory_adjustment','operating_expenses')
            OR LOWER(name) LIKE '%adjustment%')
     ORDER BY (detail_type = 'inventory_adjustment') DESC, code LIMIT 1;
  ELSIF p_purpose = 'opening_equity' THEN
    SELECT id INTO v_account_id FROM public.accounts
     WHERE business_id = p_business_id AND organization_id = v_org_id
       AND account_type = 'equity' AND is_active = true
       AND (LOWER(name) LIKE '%opening%' OR LOWER(name) LIKE '%retained%' OR code LIKE '3%')
     ORDER BY code LIMIT 1;
  END IF;

  RETURN v_account_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.resolve_default_account(uuid, text, uuid) TO anon, authenticated, service_role;

-- 4. RLS tightening: branch override rows require branch access.
--    Company-default rows (branch_id IS NULL) keep the existing
--    "financials.write" permission gate. Existing SELECT/INSERT/UPDATE
--    policies on default_accounts already cover read+write; replace
--    INSERT/UPDATE/DELETE with branch-aware variants.
DROP POLICY IF EXISTS default_accounts_insert ON public.default_accounts;
DROP POLICY IF EXISTS default_accounts_update ON public.default_accounts;
DROP POLICY IF EXISTS default_accounts_delete ON public.default_accounts;

CREATE POLICY default_accounts_insert ON public.default_accounts
  FOR INSERT TO authenticated
  WITH CHECK (
    public.user_can_access_business(auth.uid(), business_id)
    AND public.user_has_module_permission(auth.uid(), organization_id, 'financials', 'write')
    AND (branch_id IS NULL OR public.can_access_branch(auth.uid(), branch_id))
  );

CREATE POLICY default_accounts_update ON public.default_accounts
  FOR UPDATE TO authenticated
  USING (
    public.user_can_access_business(auth.uid(), business_id)
    AND public.user_has_module_permission(auth.uid(), organization_id, 'financials', 'write')
    AND (branch_id IS NULL OR public.can_access_branch(auth.uid(), branch_id))
  )
  WITH CHECK (
    public.user_can_access_business(auth.uid(), business_id)
    AND public.user_has_module_permission(auth.uid(), organization_id, 'financials', 'write')
    AND (branch_id IS NULL OR public.can_access_branch(auth.uid(), branch_id))
  );

CREATE POLICY default_accounts_delete ON public.default_accounts
  FOR DELETE TO authenticated
  USING (
    public.user_can_access_business(auth.uid(), business_id)
    AND public.user_has_module_permission(auth.uid(), organization_id, 'financials', 'delete')
    AND (branch_id IS NULL OR public.can_access_branch(auth.uid(), branch_id))
  );

-- 5. POS security settings resolver (column already exists; just needs
--    a server-side branch-preferring lookup).
CREATE OR REPLACE FUNCTION public.resolve_pos_security_settings(
  p_business_id uuid,
  p_branch_id uuid
) RETURNS SETOF public.pos_security_settings
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT * FROM public.pos_security_settings
   WHERE business_id = p_business_id
     AND ((p_branch_id IS NOT NULL AND branch_id = p_branch_id)
          OR branch_id IS NULL)
   ORDER BY (branch_id IS NULL) ASC
   LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.resolve_pos_security_settings(uuid, uuid) TO anon, authenticated, service_role;
