
ALTER TABLE public.payroll_return_template_overrides
  ADD COLUMN IF NOT EXISTS submission_channel text,
  ADD COLUMN IF NOT EXISTS submission_format  jsonb,
  ADD COLUMN IF NOT EXISTS output             text,
  ADD COLUMN IF NOT EXISTS due_day            integer,
  ADD COLUMN IF NOT EXISTS due_month_offset   integer;

COMMENT ON COLUMN public.payroll_return_template_overrides.submission_channel IS
  'Slice C: operational override. NULL = inherit pack template.';
COMMENT ON COLUMN public.payroll_return_template_overrides.submission_format IS
  'Slice C: operational override (typed jsonb {kind, options}). NULL = inherit.';
COMMENT ON COLUMN public.payroll_return_template_overrides.output IS
  'Slice C: operational override (csv|pdf|both). NULL = inherit.';
COMMENT ON COLUMN public.payroll_return_template_overrides.due_day IS
  'Slice C: operational override. NULL = inherit pack template.';
COMMENT ON COLUMN public.payroll_return_template_overrides.due_month_offset IS
  'Slice C: operational override. NULL = inherit pack template.';
