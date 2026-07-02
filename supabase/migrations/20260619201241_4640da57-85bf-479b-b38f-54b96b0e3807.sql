-- Employee self-service: allow employees to SELECT their own tax certificates.
CREATE POLICY "tax_cert_employee_self_read"
ON public.payroll_tax_certificates
FOR SELECT
TO authenticated
USING (
  employee_id IN (
    SELECT id FROM public.employees WHERE user_id = auth.uid()
  )
);