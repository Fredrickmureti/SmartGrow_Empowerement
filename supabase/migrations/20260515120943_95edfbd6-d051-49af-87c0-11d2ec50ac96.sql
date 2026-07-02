
-- Platform-admin write policies for localization-pack authoring tables.
-- All tables already have public/authenticated SELECT policies which we keep.

DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'localization_packs',
    'localization_pack_payroll_templates',
    'localization_pack_tax_templates',
    'localization_pack_account_templates',
    'localization_pack_remittance_schedules',
    'localization_pack_certificate_templates',
    'localization_pack_return_templates'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('DROP POLICY IF EXISTS "Platform admins manage %I" ON public.%I', t, t);
    EXECUTE format($pol$
      CREATE POLICY "Platform admins manage %I"
        ON public.%I
        FOR ALL
        TO authenticated
        USING (public.is_platform_admin(auth.uid()))
        WITH CHECK (public.is_platform_admin(auth.uid()))
    $pol$, t, t);
  END LOOP;
END $$;
