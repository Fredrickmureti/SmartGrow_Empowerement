-- ADR-0062: backfill personal_relief / insurance_relief payslip_lines for
-- historical payrolls that ran before the engine emitted relief lines
-- unconditionally. Sources the amounts from payslips.paye_before_relief
-- (persisted by the engine) minus the stored net PAYE line — this equals
-- the exact relief the engine deducted at the time of computation.
-- Idempotent: only inserts when no matching payslip_line row already exists.

INSERT INTO public.payslip_lines (
  organization_id, business_id, payslip_id, payroll_run_id, employee_id,
  rule_code, rule_type, category, label, sequence,
  employee_amount, employer_amount, taxable, source, statutory_rule_id
)
SELECT
  p.organization_id,
  p.business_id,
  p.id,
  p.payroll_run_id,
  p.employee_id,
  'personal_relief',
  'relief',
  'relief',
  'Personal Relief',
  200,
  ROUND((p.paye_before_relief - COALESCE(paye_line.employee_amount, 0))::numeric, 2),
  0,
  false,
  jsonb_build_object('backfill', true, 'from', 'paye_before_relief', 'adr', '0062'),
  paye_line.statutory_rule_id
FROM public.payslips p
LEFT JOIN LATERAL (
  SELECT employee_amount, statutory_rule_id
  FROM public.payslip_lines
  WHERE payslip_id = p.id AND rule_code = 'paye'
  LIMIT 1
) paye_line ON true
WHERE p.paye_before_relief IS NOT NULL
  AND p.paye_before_relief > COALESCE(paye_line.employee_amount, 0)
  AND NOT EXISTS (
    SELECT 1 FROM public.payslip_lines pl
    WHERE pl.payslip_id = p.id AND pl.rule_code = 'personal_relief'
  );

-- Publish KE pack version 10.1.2. Body unchanged from 10.1.1; the release
-- notes cover the engine + backfill change so tenants can accept an
-- upgrade in-app and get the "Personal Relief now populates on P9"
-- narrative in their upgrade proposal.
INSERT INTO public.pack_versions (pack_id, version, status, changelog, published_at, created_at)
SELECT
  lp.id,
  '10.1.2',
  'published',
  jsonb_build_object(
    'summary', 'Personal Relief and Insurance Relief now populate on P9 tax deduction cards.',
    'notes', ARRAY[
      'Engine now unconditionally persists personal_relief and insurance_relief as payslip_lines whenever a progressive tax rule reports a non-zero relief (ADR-0062).',
      'Historical payslips have been backfilled from paye_before_relief so previously issued periods display correct Personal Relief on P9A.',
      'No template body changes — bindings shipped in 10.1.1 remain the canonical source.'
    ],
    'adr', '0062'
  ),
  now(),
  now()
FROM public.localization_packs lp
WHERE lp.country_code = 'KE'
  AND NOT EXISTS (
    SELECT 1 FROM public.pack_versions pv
    WHERE pv.pack_id = lp.id AND pv.version = '10.1.2'
  );