
CREATE OR REPLACE FUNCTION public.payslip_bucket(cat public.payslip_line_category)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT public.payslip_bucket(cat::text);
$$;

COMMENT ON FUNCTION public.payslip_bucket(public.payslip_line_category) IS
  'Enum overload of payslip_bucket(text). Delegates so the trigger can call '
  'payslip_bucket(payslip_lines.category) without an explicit cast.';
