ALTER TABLE public.payroll_settings
  ADD COLUMN IF NOT EXISTS payslip_show_employer_statutory_ids boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.payroll_settings.payslip_show_employer_statutory_ids IS
  'When true, the payslip PDF prints the employer''s statutory registration numbers (KRA PIN, NSSF No., SHIF No., AHL No., etc.) consumed by the rules that ran this period. When false (industry default, matches Odoo), only the employer name is printed. Blank identifier values are always omitted — never rendered as MISSING.';