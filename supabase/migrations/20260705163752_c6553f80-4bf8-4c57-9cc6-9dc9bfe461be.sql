
-- Payroll audit closeout: persist taxable base + PAYE-before-relief on payslips
-- so reports and tax certificates can read them without walking payslip_lines.source.
ALTER TABLE public.payslips
  ADD COLUMN IF NOT EXISTS taxable_base numeric(18,2),
  ADD COLUMN IF NOT EXISTS paye_before_relief numeric(18,2);

COMMENT ON COLUMN public.payslips.taxable_base IS
  'Final base after Pass-A statutory deductions (NSSF/SHIF/AHL/pension/exemptions) that PAYE was computed against. Populated by compute-payroll from the engine trace. Nullable for pre-2026-07 payslips.';
COMMENT ON COLUMN public.payslips.paye_before_relief IS
  'Sum of gross tax across bracket_progressive income_tax rules before personal/insurance/AHR reliefs. Reported on P9A as "Tax charged". Nullable for pre-2026-07 payslips.';
