DROP FUNCTION IF EXISTS public.generate_recurring_invoice_now(uuid) CASCADE;
DROP FUNCTION IF EXISTS public.generate_recurring_invoice_now() CASCADE;
DROP FUNCTION IF EXISTS public.set_recurring_status_atomic(uuid, text, text) CASCADE;
DROP FUNCTION IF EXISTS public._recurring_bump_definition_version() CASCADE;
DROP FUNCTION IF EXISTS public._recurring_complete_if_finished() CASCADE;
DROP FUNCTION IF EXISTS public._recurring_items_version_trigger() CASCADE;
DROP FUNCTION IF EXISTS public._recurring_status_write_guard() CASCADE;
DROP FUNCTION IF EXISTS public._recurring_engine_scenarios() CASCADE;

DROP TABLE IF EXISTS public.recurring_invoice_test_results CASCADE;
DROP TABLE IF EXISTS public.recurring_invoice_status_events CASCADE;
DROP TABLE IF EXISTS public.recurring_invoice_definition_versions CASCADE;
DROP TABLE IF EXISTS public.recurring_invoice_runs CASCADE;
DROP TABLE IF EXISTS public.recurring_invoice_items CASCADE;
DROP TABLE IF EXISTS public.recurring_invoices CASCADE;