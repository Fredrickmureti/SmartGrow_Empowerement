-- Payroll & Localization Hardening (audit close-out)

ALTER TABLE IF EXISTS public.employee_statutory_identifiers
  ALTER COLUMN country_code DROP DEFAULT;

DROP FUNCTION IF EXISTS public.calculate_kenya_paye(numeric) CASCADE;
DROP FUNCTION IF EXISTS public.calculate_kenya_nhif(numeric) CASCADE;
DROP FUNCTION IF EXISTS public.calculate_kenya_nssf(numeric) CASCADE;
DROP FUNCTION IF EXISTS public.calculate_kenya_paye(numeric, numeric) CASCADE;
DROP FUNCTION IF EXISTS public.calculate_kenya_housing_levy(numeric) CASCADE;

CREATE TABLE IF NOT EXISTS public.pack_account_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pack_id uuid NOT NULL REFERENCES public.localization_packs(id) ON DELETE CASCADE,
  role_key text NOT NULL,
  display_name text NOT NULL,
  account_type text NOT NULL CHECK (account_type IN ('asset','liability','equity','revenue','expense')),
  detail_type text,
  description text,
  is_required boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pack_id, role_key)
);

ALTER TABLE public.pack_account_roles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "pack_account_roles_read_all" ON public.pack_account_roles;
CREATE POLICY "pack_account_roles_read_all"
  ON public.pack_account_roles FOR SELECT
  USING (true);

DROP POLICY IF EXISTS "pack_account_roles_platform_admin_write" ON public.pack_account_roles;
CREATE POLICY "pack_account_roles_platform_admin_write"
  ON public.pack_account_roles FOR ALL
  USING (public.has_role(auth.uid(), 'platform_admin'))
  WITH CHECK (public.has_role(auth.uid(), 'platform_admin'));

COMMENT ON TABLE public.pack_account_roles IS
  'Per-localization-pack registration of statutory account roles. Mirrored into system_account_roles by payroll_install_pack_account_roles so payroll posting works for arbitrary countries with no core code change.';

CREATE OR REPLACE FUNCTION public.payroll_install_pack_account_roles(p_pack_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer := 0;
BEGIN
  INSERT INTO public.system_account_roles (role_key, display_name, account_type, detail_type, description, is_required)
  SELECT par.role_key, par.display_name, par.account_type, par.detail_type, par.description, par.is_required
  FROM public.pack_account_roles par
  WHERE par.pack_id = p_pack_id
  ON CONFLICT (role_key) DO UPDATE
    SET display_name = EXCLUDED.display_name,
        account_type = EXCLUDED.account_type,
        detail_type  = COALESCE(EXCLUDED.detail_type, public.system_account_roles.detail_type),
        description  = COALESCE(EXCLUDED.description, public.system_account_roles.description);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

COMMENT ON FUNCTION public.payroll_install_pack_account_roles(uuid) IS
  'Idempotently mirrors pack_account_roles rows into system_account_roles. Should be called by install_localization_pack_atomic post-template-seed.';
