
INSERT INTO public.custom_deduction_types (
  business_id, code, label, description,
  deduction_kind, tax_treatment, is_taxable, is_employer_contribution,
  computation_method, parameters, payslip_group, sort_order,
  requires_approval, is_active, payroll_rule_code
) VALUES (
  'bf392ca6-a743-435c-ae41-5bf25199470d',
  'nssf_voluntary',
  'NSSF Voluntary (Type 105)',
  'Employee opt-in voluntary NSSF contribution per signed Type-105 check-off form. Bound to Kenya pack rule nssf_voluntary; feeds the NSSF return VOLUNTARY column and tier3_payable GL.',
  'voluntary',
  'post_tax',
  false,
  false,
  'flat_amount',
  '{"currency":"KES"}'::jsonb,
  'statutory',
  50,
  false,
  true,
  'nssf_voluntary'
);

INSERT INTO public.employee_custom_deductions (
  business_id, employee_id, deduction_type_id,
  effective_from, amount_override, status, reference, notes
)
SELECT
  'bf392ca6-a743-435c-ae41-5bf25199470d',
  '5449cd48-bbf2-42da-a279-907ac2dfc9ce',
  cdt.id,
  date_trunc('month', current_date)::date,
  2000,
  'active',
  'NSSF-105-DEMO-0001',
  'Teaching-run enrollment: signed check-off form on file, KES 2,000/month.'
FROM public.custom_deduction_types cdt
WHERE cdt.business_id = 'bf392ca6-a743-435c-ae41-5bf25199470d'
  AND cdt.code = 'nssf_voluntary';
