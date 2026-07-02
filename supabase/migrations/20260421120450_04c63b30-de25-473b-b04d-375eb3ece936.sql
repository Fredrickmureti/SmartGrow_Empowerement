-- Drop deprecated org-level localization_status (Wave A re-parented to Company/business level)
ALTER TABLE public.organizations DROP COLUMN IF EXISTS localization_status;