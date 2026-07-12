
-- Drop legacy scalar artifact columns on payroll_return_runs. Every reader
-- (ReturnsTab, useStatutoryReturns, generate-statutory-return, submit-
-- statutory-return) has been migrated to the canonical `artifacts` jsonb
-- column in the same release. `artifacts` was backfilled from these
-- scalars in migration 20260711232041, so no data is lost.
ALTER TABLE public.payroll_return_runs DROP COLUMN IF EXISTS csv_path;
ALTER TABLE public.payroll_return_runs DROP COLUMN IF EXISTS pdf_path;
ALTER TABLE public.payroll_return_runs DROP COLUMN IF EXISTS gov_file_path;

-- Drop the legacy single-format scalar on the pack template row. Every
-- template's `outputs jsonb` was backfilled from this scalar earlier in
-- the same day (see data patch 2026-07-12), so publishers do not lose
-- any information. Dispatch in `generate-statutory-return` is now driven
-- exclusively off `outputs`.
ALTER TABLE public.localization_pack_return_templates DROP COLUMN IF EXISTS output;
