-- Remove sample/demo data provisioning feature entirely.
-- Drops the sample-data RPC and the dismissal flag from organizations.
-- The `is_sample_data` columns on individual tables are left in place as
-- legacy defensive filters (dropping them risks breaking many tables/views).

DROP FUNCTION IF EXISTS public.clear_sample_data(uuid);

ALTER TABLE public.organizations
  DROP COLUMN IF EXISTS sample_data_prompt_dismissed;