CREATE UNIQUE INDEX IF NOT EXISTS localization_pack_account_templates_pack_role_uniq
  ON public.localization_pack_account_templates (pack_id, role_key)
  WHERE role_key IS NOT NULL;