-- Drop deprecated tenant-scoped logo column. Per Odoo res.company model,
-- the logo lives on the legal entity (businesses), not the workspace.
-- Verified before migration: 0 organizations have a logo without a
-- corresponding business logo, so no data is lost.
ALTER TABLE public.organizations DROP COLUMN IF EXISTS logo_url;