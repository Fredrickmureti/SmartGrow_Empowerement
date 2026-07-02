
-- Phase 0: ensure every stored rule has the schema-required `period` key.
-- Adds period='monthly' where missing, leaves existing values untouched,
-- and audits every change to pack_migration_log.

DO $$
DECLARE
  v_row RECORD;
  v_before jsonb;
  v_after jsonb;
BEGIN
  -- payroll_statutory_rules (tenant copies)
  FOR v_row IN
    SELECT id, organization_id, business_id, parameters
    FROM public.payroll_statutory_rules
    WHERE parameters IS NOT NULL
      AND jsonb_typeof(parameters) = 'object'
      AND NOT (parameters ? 'period')
  LOOP
    v_before := v_row.parameters;
    v_after  := v_row.parameters || jsonb_build_object('period', 'monthly');
    UPDATE public.payroll_statutory_rules
       SET parameters = v_after
     WHERE id = v_row.id;

    BEGIN
      INSERT INTO public.pack_migration_log
        (organization_id, business_id, kind, target_table, target_id, before, after, reason)
      VALUES
        (v_row.organization_id, v_row.business_id, 'backfill',
         'payroll_statutory_rules', v_row.id, v_before, v_after,
         'phase0_period_backfill');
    EXCEPTION WHEN undefined_table OR undefined_column THEN
      -- pack_migration_log shape varies across earlier migrations; do
      -- not block the backfill if the audit table isn't in this shape.
      NULL;
    END;
  END LOOP;

  -- localization_pack_payroll_templates (publisher copies)
  FOR v_row IN
    SELECT id, parameters
    FROM public.localization_pack_payroll_templates
    WHERE parameters IS NOT NULL
      AND jsonb_typeof(parameters) = 'object'
      AND NOT (parameters ? 'period')
  LOOP
    v_before := v_row.parameters;
    v_after  := v_row.parameters || jsonb_build_object('period', 'monthly');
    UPDATE public.localization_pack_payroll_templates
       SET parameters = v_after
     WHERE id = v_row.id;

    BEGIN
      INSERT INTO public.pack_migration_log
        (organization_id, business_id, kind, target_table, target_id, before, after, reason)
      VALUES
        (NULL, NULL, 'backfill',
         'localization_pack_payroll_templates', v_row.id, v_before, v_after,
         'phase0_period_backfill');
    EXCEPTION WHEN undefined_table OR undefined_column THEN
      NULL;
    END;
  END LOOP;
END $$;
