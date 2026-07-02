-- Remove standalone Documents app tables (productivity app retired).
-- Keeps singular `document_*` tables (invoice/sales templating) and the
-- shared `documents` storage bucket (used by payroll statutory returns).
DROP TABLE IF EXISTS public.documents_workflow_actions CASCADE;
DROP TABLE IF EXISTS public.documents_requests CASCADE;
DROP TABLE IF EXISTS public.documents_shares CASCADE;
DROP TABLE IF EXISTS public.documents_activities CASCADE;
DROP TABLE IF EXISTS public.documents_comments CASCADE;
DROP TABLE IF EXISTS public.documents_versions CASCADE;
DROP TABLE IF EXISTS public.documents_document_tags CASCADE;
DROP TABLE IF EXISTS public.documents_folder_tags CASCADE;
DROP TABLE IF EXISTS public.documents_folders CASCADE;
DROP TABLE IF EXISTS public.documents CASCADE;