
-- =====================================================================
-- STEP 1 — Backfill system Access Groups for every existing workspace
-- =====================================================================
DO $$
DECLARE v_org_id uuid;
BEGIN
  FOR v_org_id IN SELECT id FROM public.organizations LOOP
    BEGIN
      PERFORM public.seed_default_permission_groups(v_org_id);
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'seed_default_permission_groups failed for org %: %', v_org_id, SQLERRM;
    END;
  END LOOP;
END$$;

-- =====================================================================
-- STEP 2 — Drop dead columns on permission_groups
-- =====================================================================
ALTER TABLE public.permission_groups DROP COLUMN IF EXISTS payroll_role;
ALTER TABLE public.permission_groups DROP COLUMN IF EXISTS is_additive;

-- =====================================================================
-- STEP 3 — Reduce the 5-arg user_has_module_permission to a thin wrapper.
-- We cannot drop the function (RLS policies depend on it) but we MUST stop
-- it from pretending to gate by business — group rules are workspace-scoped
-- after the Stage-2 cleanup. Wrapper delegates to the 4-arg form so the
-- behaviour is identical and unambiguous.
-- =====================================================================
CREATE OR REPLACE FUNCTION public.user_has_module_permission(
  _user_id uuid,
  _org_id uuid,
  _business_id uuid,  -- intentionally ignored: group rules are workspace-scoped
  _module text,
  _operation text
)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT public.user_has_module_permission(_user_id, _org_id, _module, _operation);
$$;

COMMENT ON FUNCTION public.user_has_module_permission(uuid, uuid, uuid, text, text)
  IS 'Workspace-scoped permission check. business_id is ignored — group rules apply across the workspace. Prefer the 4-arg overload in new code.';

-- =====================================================================
-- STEP 5 — Make numbering RPCs branch-aware
-- =====================================================================
-- 5a. Invoice numbering.
CREATE OR REPLACE FUNCTION public.generate_invoice_number(
  p_organization_id uuid,
  p_business_id uuid DEFAULT NULL,
  p_branch_id uuid DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_prefix text := 'INV';
  v_next_num integer;
  v_cfg jsonb;
BEGIN
  IF p_business_id IS NOT NULL AND p_branch_id IS NOT NULL THEN
    v_cfg := public.get_effective_company_config(p_business_id, p_branch_id);
    v_prefix := COALESCE(NULLIF(v_cfg->'invoice_prefix'->>'value', ''), 'INV');
  ELSIF p_business_id IS NOT NULL THEN
    SELECT COALESCE(invoice_prefix, 'INV') INTO v_prefix
    FROM public.businesses WHERE id = p_business_id;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('invoices_' || p_organization_id::text || '_' || COALESCE(p_branch_id::text, 'global')));

  SELECT COALESCE(MAX(
    CASE
      WHEN invoice_number ~ '[0-9]+$'
      THEN CAST(SUBSTRING(invoice_number FROM '[0-9]+$') AS INTEGER)
      ELSE 0
    END
  ), 0) + 1 INTO v_next_num
  FROM public.invoices
  WHERE organization_id = p_organization_id
    AND (p_branch_id IS NULL OR branch_id = p_branch_id);

  RETURN v_prefix || '-' || LPAD(v_next_num::text, 6, '0');
END;
$$;

-- 5b. Bill numbering.
CREATE OR REPLACE FUNCTION public.get_next_bill_number(
  _org_id uuid,
  _business_id uuid DEFAULT NULL,
  _branch_id uuid DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  next_num integer;
  prefix text := 'BILL-';
  v_cfg jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('bills_' || _org_id::text || '_' || COALESCE(_branch_id::text, 'global')));

  IF _business_id IS NOT NULL AND _branch_id IS NOT NULL THEN
    v_cfg := public.get_effective_company_config(_business_id, _branch_id);
    prefix := COALESCE(NULLIF(v_cfg->'bill_prefix'->>'value', ''), 'BILL-');
  ELSIF _business_id IS NOT NULL THEN
    SELECT COALESCE(b.bill_prefix, 'BILL-') INTO prefix
    FROM public.businesses b WHERE b.id = _business_id;
  ELSE
    SELECT COALESCE(b.bill_prefix, 'BILL-') INTO prefix
    FROM public.businesses b WHERE b.organization_id = _org_id LIMIT 1;
  END IF;
  prefix := COALESCE(prefix, 'BILL-');

  SELECT COALESCE(MAX(
    CASE WHEN bill_number ~ '\d+$'
      THEN CAST(substring(bill_number FROM '\d+$') AS integer)
      ELSE 0
    END
  ), 0) + 1 INTO next_num
  FROM public.bills
  WHERE organization_id = _org_id
    AND (_branch_id IS NULL OR branch_id = _branch_id);

  RETURN prefix || LPAD(next_num::text, 5, '0');
END;
$$;

-- 5c. Estimate numbering. Also fixes a long-standing bug (was reading
-- estimate_prefix from `organizations` but it lives on `businesses`).
CREATE OR REPLACE FUNCTION public.get_next_estimate_number(
  _org_id uuid,
  _business_id uuid DEFAULT NULL,
  _branch_id uuid DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  next_num integer;
  year_prefix text;
  prefix text := 'EST';
  v_cfg jsonb;
BEGIN
  year_prefix := to_char(CURRENT_DATE, 'YYYY');

  IF _business_id IS NOT NULL AND _branch_id IS NOT NULL THEN
    v_cfg := public.get_effective_company_config(_business_id, _branch_id);
    prefix := COALESCE(NULLIF(v_cfg->'estimate_prefix'->>'value', ''), 'EST');
  ELSIF _business_id IS NOT NULL THEN
    SELECT COALESCE(estimate_prefix, 'EST') INTO prefix
    FROM public.businesses WHERE id = _business_id;
  ELSE
    SELECT COALESCE(estimate_prefix, 'EST') INTO prefix
    FROM public.businesses WHERE organization_id = _org_id LIMIT 1;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('estimates_' || _org_id::text || '_' || COALESCE(_branch_id::text, 'global')));

  SELECT COALESCE(MAX(
    CAST(NULLIF(regexp_replace(estimate_number, '[^0-9]', '', 'g'), '') AS INTEGER)
  ), 0) + 1 INTO next_num
  FROM public.estimates
  WHERE organization_id = _org_id
    AND (_branch_id IS NULL OR branch_id = _branch_id)
    AND estimate_number LIKE prefix || '-' || year_prefix || '-%';

  RETURN prefix || '-' || year_prefix || '-' || LPAD(next_num::text, 4, '0');
END;
$$;

-- 5d. Receipt numbering.
CREATE OR REPLACE FUNCTION public.get_next_receipt_number(
  _org_id uuid,
  _business_id uuid DEFAULT NULL,
  _branch_id uuid DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _next_num integer;
  _prefix text := 'RCP';
  v_cfg jsonb;
BEGIN
  IF _business_id IS NOT NULL AND _branch_id IS NOT NULL THEN
    v_cfg := public.get_effective_company_config(_business_id, _branch_id);
    _prefix := COALESCE(NULLIF(v_cfg->'receipt_prefix'->>'value', ''), 'RCP');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('receipts_' || _org_id::text || '_' || COALESCE(_branch_id::text, 'global')));

  SELECT COALESCE(MAX(
    CASE
      WHEN receipt_number ~ '[0-9]+$'
      THEN CAST(regexp_replace(receipt_number, '[^0-9]', '', 'g') AS INTEGER)
      ELSE 0
    END
  ), 0) + 1 INTO _next_num
  FROM public.payments
  WHERE organization_id = _org_id
    AND (_branch_id IS NULL OR branch_id = _branch_id)
    AND receipt_number IS NOT NULL;

  RETURN _prefix || '-' || LPAD(_next_num::text, 6, '0');
END;
$$;

GRANT EXECUTE ON FUNCTION public.generate_invoice_number(uuid, uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_next_bill_number(uuid, uuid, uuid)    TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_next_estimate_number(uuid, uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_next_receipt_number(uuid, uuid, uuid)  TO authenticated;
