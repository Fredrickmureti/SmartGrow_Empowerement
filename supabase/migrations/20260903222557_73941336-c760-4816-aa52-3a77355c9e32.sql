DROP VIEW IF EXISTS public.v_org_active_localization_pack CASCADE;

DROP TABLE IF EXISTS
  public.installed_localization_packs,
  public.localization_pack_account_templates,
  public.localization_pack_bank_export_templates,
  public.localization_pack_certificate_templates,
  public.localization_pack_fiscal_code_maps,
  public.localization_pack_fiscal_providers,
  public.localization_pack_garnishment_kinds,
  public.localization_pack_garnishment_policies,
  public.localization_pack_payroll_templates,
  public.localization_pack_remittance_schedules,
  public.localization_pack_return_templates,
  public.localization_pack_tax_templates,
  public.localization_pack_work_entry_type_templates,
  public.localization_packs,
  public.pack_account_roles,
  public.pack_audit_log,
  public.pack_migration_log,
  public.pack_publisher_grants,
  public.pack_requirements,
  public.pack_return_run_audit,
  public.pack_rule_conflicts,
  public.pack_rule_type_schemas,
  public.pack_token_registry,
  public.pack_upgrade_proposals,
  public.pack_versions
CASCADE;