
-- Decommission retired apps: Documents, Sign, Spreadsheets
-- All targeted tables verified at 0 rows. Idempotent via IF EXISTS / to_regclass guards.

-- 1. Plan access wiring
DELETE FROM public.plan_app_access WHERE app_id IN ('documents','sign','spreadsheets');

-- 2. Platform catalog rows (drives Admin App Catalog + signup)
DELETE FROM public.platform_apps WHERE id IN ('documents','sign','spreadsheets');

-- 3. Drop Spreadsheets domain tables (CASCADE handles FKs, triggers, policies)
DROP TABLE IF EXISTS public.spreadsheet_user_filter_values CASCADE;
DROP TABLE IF EXISTS public.spreadsheet_filter_pivot_mappings CASCADE;
DROP TABLE IF EXISTS public.spreadsheet_global_filters CASCADE;
DROP TABLE IF EXISTS public.spreadsheet_pivots CASCADE;
DROP TABLE IF EXISTS public.spreadsheet_validation_rules CASCADE;
DROP TABLE IF EXISTS public.spreadsheet_data_sources CASCADE;
DROP TABLE IF EXISTS public.spreadsheet_shares CASCADE;
DROP TABLE IF EXISTS public.spreadsheet_versions CASCADE;
DROP TABLE IF EXISTS public.spreadsheet_sheets CASCADE;
DROP TABLE IF EXISTS public.dashboard_spreadsheet_pins CASCADE;
DROP TABLE IF EXISTS public.spreadsheets CASCADE;

-- 4. Drop E-Sign domain tables
DROP TABLE IF EXISTS public.signature_audit_log CASCADE;
DROP TABLE IF EXISTS public.signature_fields CASCADE;
DROP TABLE IF EXISTS public.signature_signers CASCADE;
DROP TABLE IF EXISTS public.signature_templates CASCADE;
DROP TABLE IF EXISTS public.signature_requests CASCADE;

-- 5. Drop Documents-app collaboration table (distinct from shared document_templates / document_emails / document_print_policies)
DROP TABLE IF EXISTS public.document_comments CASCADE;

-- 6. Drop Spreadsheets-specific helper functions if any survived the cascade
DROP FUNCTION IF EXISTS public.can_manage_spreadsheet_shares(uuid, uuid) CASCADE;
DROP FUNCTION IF EXISTS public.has_spreadsheet_share_access(uuid, uuid) CASCADE;
DROP FUNCTION IF EXISTS public.cleanup_old_spreadsheet_versions() CASCADE;
DROP FUNCTION IF EXISTS public.update_spreadsheet_updated_at() CASCADE;
