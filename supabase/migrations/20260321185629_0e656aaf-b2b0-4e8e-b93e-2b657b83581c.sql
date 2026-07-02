
-- Remove FK constraints referencing report_templates
ALTER TABLE IF EXISTS public.report_generation_logs DROP CONSTRAINT IF EXISTS report_generation_logs_template_id_fkey;
ALTER TABLE IF EXISTS public.scheduled_reports DROP CONSTRAINT IF EXISTS scheduled_reports_template_id_fkey;

-- Drop the orphaned report_templates table
DROP TABLE IF EXISTS public.report_templates;
