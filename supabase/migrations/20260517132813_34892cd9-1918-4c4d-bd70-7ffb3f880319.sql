-- Allow upsert by (organization_id, business_id, branch_id, setting_key).
-- NULLS NOT DISTINCT treats two NULL branch_ids as equal so the
-- branch-less default row stays unique per setting_key.
ALTER TABLE public.default_account_settings
  ADD CONSTRAINT default_account_settings_scope_key
  UNIQUE NULLS NOT DISTINCT (organization_id, business_id, branch_id, setting_key);