
-- Phase 4: Multi-jurisdiction schema unblock
-- =========================================
-- Allows a single business to install multiple localization packs (e.g.
-- KE + UG for a regional employer) and lets each employee declare their
-- own statutory jurisdiction.

-- 1. Drop the one-pack-per-business hard cap; replace with one-row-per-pack-per-business.
DROP INDEX IF EXISTS public.installed_localization_packs_business_unique;

CREATE UNIQUE INDEX IF NOT EXISTS installed_localization_packs_business_pack_unique
  ON public.installed_localization_packs (business_id, pack_id)
  WHERE business_id IS NOT NULL;

-- Keep org-scoped uniqueness for org-wide (business_id IS NULL) installs.
CREATE UNIQUE INDEX IF NOT EXISTS installed_localization_packs_org_pack_unique
  ON public.installed_localization_packs (organization_id, pack_id)
  WHERE business_id IS NULL;

-- 2. Per-employee statutory jurisdiction.
ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS statutory_country_code text;

COMMENT ON COLUMN public.employees.statutory_country_code IS
  'ISO-3166-1 alpha-2 country code that determines which localization pack applies to this employee for payroll, statutory deductions, and remittances. NULL falls back to business.country.';

CREATE INDEX IF NOT EXISTS idx_employees_statutory_country_code
  ON public.employees (statutory_country_code)
  WHERE statutory_country_code IS NOT NULL;

-- One-shot backfill from business.country. Idempotent (only fills NULLs).
UPDATE public.employees e
   SET statutory_country_code = upper(b.country)
  FROM public.businesses b
 WHERE e.statutory_country_code IS NULL
   AND e.business_id = b.id
   AND b.country IS NOT NULL;

-- 3. Pack resolver: returns the installed pack id for an employee's jurisdiction.
--    Fallback chain: employee.statutory_country_code → business default pack → org default pack.
CREATE OR REPLACE FUNCTION public.resolve_payroll_pack_for_employee(p_employee_id uuid)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org_id uuid;
  v_business_id uuid;
  v_country text;
  v_pack_id uuid;
BEGIN
  SELECT organization_id, business_id, statutory_country_code
    INTO v_org_id, v_business_id, v_country
    FROM public.employees
   WHERE id = p_employee_id;

  IF v_org_id IS NULL THEN
    RETURN NULL;
  END IF;

  -- Tier 1: employee's declared country → business-scoped pack.
  IF v_country IS NOT NULL AND v_business_id IS NOT NULL THEN
    SELECT ip.pack_id INTO v_pack_id
      FROM public.installed_localization_packs ip
      JOIN public.localization_packs lp ON lp.id = ip.pack_id
     WHERE ip.business_id = v_business_id
       AND upper(lp.country_code) = upper(v_country)
     LIMIT 1;
    IF v_pack_id IS NOT NULL THEN RETURN v_pack_id; END IF;
  END IF;

  -- Tier 2: employee's declared country → org-wide pack.
  IF v_country IS NOT NULL THEN
    SELECT ip.pack_id INTO v_pack_id
      FROM public.installed_localization_packs ip
      JOIN public.localization_packs lp ON lp.id = ip.pack_id
     WHERE ip.organization_id = v_org_id
       AND ip.business_id IS NULL
       AND upper(lp.country_code) = upper(v_country)
     LIMIT 1;
    IF v_pack_id IS NOT NULL THEN RETURN v_pack_id; END IF;
  END IF;

  -- Tier 3: business default (any installed pack on the business).
  IF v_business_id IS NOT NULL THEN
    SELECT ip.pack_id INTO v_pack_id
      FROM public.installed_localization_packs ip
     WHERE ip.business_id = v_business_id
     ORDER BY ip.installed_at DESC NULLS LAST
     LIMIT 1;
    IF v_pack_id IS NOT NULL THEN RETURN v_pack_id; END IF;
  END IF;

  -- Tier 4: org default.
  SELECT ip.pack_id INTO v_pack_id
    FROM public.installed_localization_packs ip
   WHERE ip.organization_id = v_org_id
   ORDER BY ip.installed_at DESC NULLS LAST
   LIMIT 1;

  RETURN v_pack_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.resolve_payroll_pack_for_employee(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.resolve_payroll_pack_for_employee(uuid) IS
  'Phase 4 multi-jurisdiction resolver. Returns the installed_localization_packs.pack_id that should drive payroll/statutory calculations for the given employee, applying the four-tier fallback chain (employee country → business → org → most-recently-installed).';

-- 4. Companion: resolve country_code per employee (used by compute-payroll to
--    pick the right statutory_rules row set without needing the pack lookup).
CREATE OR REPLACE FUNCTION public.resolve_statutory_country_for_employee(p_employee_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    upper(e.statutory_country_code),
    upper(b.country)
  )
  FROM public.employees e
  LEFT JOIN public.businesses b ON b.id = e.business_id
  WHERE e.id = p_employee_id;
$$;

GRANT EXECUTE ON FUNCTION public.resolve_statutory_country_for_employee(uuid) TO authenticated, service_role;
