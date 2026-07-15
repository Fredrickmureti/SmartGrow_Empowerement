CREATE OR REPLACE FUNCTION public.payroll_report_definitions_for_tenant(
  p_organization_id uuid,
  p_business_id uuid DEFAULT NULL
)
RETURNS SETOF public.payroll_report_definitions
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT d.*
    FROM public.payroll_report_definitions d
   WHERE d.is_active = true
     AND (
       -- Platform reports: always visible.
       d.owner_kind <> 'localization_pack'
       OR
       -- Localization-pack reports: only when installed for this tenant.
       (
         d.owner_kind = 'localization_pack'
         AND d.localization_pack_id IS NOT NULL
         AND EXISTS (
           SELECT 1
             FROM public.installed_localization_packs i
            WHERE i.pack_id = d.localization_pack_id
              AND i.organization_id = p_organization_id
              AND (
                p_business_id IS NULL
                OR i.business_id IS NULL
                OR i.business_id = p_business_id
              )
         )
       )
     )
   ORDER BY d.sort_order ASC;
$$;

GRANT EXECUTE ON FUNCTION public.payroll_report_definitions_for_tenant(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.payroll_report_definitions_for_tenant(uuid, uuid) TO service_role;

COMMENT ON FUNCTION public.payroll_report_definitions_for_tenant(uuid, uuid) IS
'Tenant-scoped visibility for payroll_report_definitions. Platform reports (owner_kind <> ''localization_pack'') are always visible; localization-pack reports are visible only when the pack is present in installed_localization_packs for the given organization/business. See ADR-0062 invariant 6.';