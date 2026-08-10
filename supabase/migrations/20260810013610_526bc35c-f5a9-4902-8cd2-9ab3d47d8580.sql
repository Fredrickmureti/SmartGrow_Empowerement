-- Retire the dead second reminder/email/activity system (all three tables are
-- empty and have no readers). `document_emails` + `audit_logs` are the single
-- canonical trail.
DROP TABLE IF EXISTS public.invoice_reminders CASCADE;
DROP TABLE IF EXISTS public.invoice_emails CASCADE;
DROP TABLE IF EXISTS public.invoice_activities CASCADE;