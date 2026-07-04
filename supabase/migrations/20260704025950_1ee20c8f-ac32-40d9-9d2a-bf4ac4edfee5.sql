
-- 1) Pack template table for Work Entry Types.
CREATE TABLE IF NOT EXISTS public.localization_pack_work_entry_type_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pack_id uuid NOT NULL REFERENCES public.localization_packs(id) ON DELETE CASCADE,
  pack_version_id uuid REFERENCES public.pack_versions(id) ON DELETE SET NULL,
  code text NOT NULL,
  name text NOT NULL,
  description text,
  color text,
  is_paid boolean NOT NULL DEFAULT true,
  is_unpaid_leave boolean NOT NULL DEFAULT false,
  counts_as_worked boolean NOT NULL DEFAULT true,
  multiplier_normal numeric(8,4) NOT NULL DEFAULT 1,
  multiplier_overtime numeric(8,4) NOT NULL DEFAULT 1.5,
  accounting_tag text,
  sequence integer NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pack_id, code)
);

CREATE INDEX IF NOT EXISTS idx_lpwet_pack ON public.localization_pack_work_entry_type_templates(pack_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.localization_pack_work_entry_type_templates TO authenticated;
GRANT ALL ON public.localization_pack_work_entry_type_templates TO service_role;

ALTER TABLE public.localization_pack_work_entry_type_templates ENABLE ROW LEVEL SECURITY;

-- Read: any authenticated user (packs are shared metadata; parity with the
-- other localization_pack_*_templates tables).
DROP POLICY IF EXISTS "lpwet_read" ON public.localization_pack_work_entry_type_templates;
CREATE POLICY "lpwet_read" ON public.localization_pack_work_entry_type_templates
  FOR SELECT TO authenticated USING (true);

-- Write: only platform admins can author pack content.
DROP POLICY IF EXISTS "lpwet_write" ON public.localization_pack_work_entry_type_templates;
CREATE POLICY "lpwet_write" ON public.localization_pack_work_entry_type_templates
  FOR ALL TO authenticated
  USING (public.is_platform_admin(auth.uid()))
  WITH CHECK (public.is_platform_admin(auth.uid()));

DROP TRIGGER IF EXISTS trg_lpwet_updated_at ON public.localization_pack_work_entry_type_templates;
CREATE TRIGGER trg_lpwet_updated_at
  BEFORE UPDATE ON public.localization_pack_work_entry_type_templates
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 2) Pack-aware seeder. Preference order:
--    a) rows from every pack currently installed for the organization;
--    b) six hard-coded canonical codes as a safety net so bare-metal orgs
--       still get a working payroll.
CREATE OR REPLACE FUNCTION public.ensure_canonical_work_entry_types(_org_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_installed_any boolean := false;
BEGIN
  -- Pack-sourced rows (idempotent per pack + code, tenant scope is NULL).
  WITH src AS (
    SELECT DISTINCT ON (t.code)
           t.pack_id, t.code, t.name, t.color,
           t.is_paid, t.is_unpaid_leave, t.counts_as_worked,
           t.multiplier_normal, t.multiplier_overtime,
           t.accounting_tag, t.sequence
      FROM public.installed_localization_packs ilp
      JOIN public.localization_pack_work_entry_type_templates t
        ON t.pack_id = ilp.pack_id
     WHERE ilp.organization_id = _org_id
     ORDER BY t.code, t.sequence, t.pack_id
  ),
  ins AS (
    INSERT INTO public.payroll_work_entry_types
      (organization_id, business_id, localization_pack_id, code, name, color,
       is_paid, is_unpaid_leave, counts_as_worked,
       multiplier_normal, multiplier_overtime, accounting_tag, sequence,
       is_pack_default, is_active)
    SELECT _org_id, NULL, src.pack_id, src.code, src.name, src.color,
           src.is_paid, src.is_unpaid_leave, src.counts_as_worked,
           src.multiplier_normal, src.multiplier_overtime, src.accounting_tag,
           src.sequence, true, true
      FROM src
    ON CONFLICT (organization_id, COALESCE(business_id, '00000000-0000-0000-0000-000000000000'::uuid), code)
      DO NOTHING
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM src) INTO v_installed_any;

  -- Safety-net canonical codes when no pack ships WET templates yet.
  IF NOT v_installed_any THEN
    INSERT INTO public.payroll_work_entry_types
      (organization_id, business_id, code, name,
       is_paid, is_unpaid_leave, counts_as_worked,
       multiplier_normal, multiplier_overtime, sequence,
       is_pack_default, is_active)
    VALUES
      (_org_id, NULL, 'WORK',           'Worked hours',      true,  false, true,  1.0, 1.0, 10, true, true),
      (_org_id, NULL, 'OT',             'Overtime',          true,  false, true,  1.0, 1.5, 20, true, true),
      (_org_id, NULL, 'LEAVE_PAID',     'Paid leave',        true,  false, false, 1.0, 1.0, 30, true, true),
      (_org_id, NULL, 'LEAVE_UNPAID',   'Unpaid leave',      false, true,  false, 0.0, 0.0, 40, true, true),
      (_org_id, NULL, 'HOLIDAY',        'Public holiday',    true,  false, false, 1.0, 1.0, 50, true, true),
      (_org_id, NULL, 'WORKED_HOLIDAY', 'Worked on holiday', true,  false, true,  1.0, 2.0, 60, true, true)
    ON CONFLICT (organization_id, COALESCE(business_id, '00000000-0000-0000-0000-000000000000'::uuid), code)
      DO NOTHING;
  END IF;
END
$$;

GRANT EXECUTE ON FUNCTION public.ensure_canonical_work_entry_types(uuid)
  TO authenticated, service_role;

-- 3) Widen the write policy on the tenant table so platform admins can
--    author the pack-default (business_id IS NULL) rows out-of-band while
--    keeping tenant-scoped writes as-is.
DROP POLICY IF EXISTS "payroll_work_entry_types_write" ON public.payroll_work_entry_types;
CREATE POLICY "payroll_work_entry_types_write" ON public.payroll_work_entry_types
  FOR ALL TO authenticated
  USING (
    (public.user_has_module_permission(auth.uid(), organization_id, 'payroll', 'write')
       AND business_id IS NOT NULL)
    OR (business_id IS NULL AND public.is_platform_admin(auth.uid()))
  )
  WITH CHECK (
    (public.user_has_module_permission(auth.uid(), organization_id, 'payroll', 'write')
       AND business_id IS NOT NULL)
    OR (business_id IS NULL AND public.is_platform_admin(auth.uid()))
  );
