
-- ============================================================
-- Wave 6.0 — Enum extensions
-- ============================================================
ALTER TYPE public.print_job_status ADD VALUE IF NOT EXISTS 'processing';
ALTER TYPE public.print_job_status ADD VALUE IF NOT EXISTS 'dead_letter';
