ALTER TABLE public.businesses
  DROP COLUMN IF EXISTS invoice_prefix,
  DROP COLUMN IF EXISTS estimate_prefix,
  DROP COLUMN IF EXISTS bill_prefix,
  DROP COLUMN IF EXISTS sales_return_prefix,
  DROP COLUMN IF EXISTS require_bill_approval,
  DROP COLUMN IF EXISTS allow_duplicate_vendor_invoice_numbers,
  DROP COLUMN IF EXISTS block_bill_approval_on_match_exception,
  DROP COLUMN IF EXISTS payroll_overtime_multiplier,
  DROP COLUMN IF EXISTS payroll_standard_hours_per_day,
  DROP COLUMN IF EXISTS payroll_standard_working_days,
  DROP COLUMN IF EXISTS payroll_self_approval_policy;