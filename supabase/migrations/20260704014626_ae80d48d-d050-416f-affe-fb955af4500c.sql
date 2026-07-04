-- Phase C — Payroll readiness integration for Loan Types
-- Adds three org-scope readiness rules driven by predicate_sql. Predicate
-- signature (per public.payroll_readiness_eval_rule):
--   USING p_org_id, p_business_id, p_subject_id, p_period_start, p_period_end
-- Boolean result: true = pass, false = fail (or warn, per rule severity).

INSERT INTO public.payroll_readiness_rules
  (organization_id, code, name, description, scope, severity, source, reason_code,
   check_kind, predicate_sql, remediation_label, remediation_link, sort_order)
VALUES
  (
    NULL,
    'loan_type.gl_complete',
    'Loan types have GL accounts mapped',
    'Every active loan type in use must have a receivable and disbursement clearing account set for JE posting to succeed.',
    'org', 'block', 'core', 'LOAN_TYPE_GL_MISSING',
    'loan_type.gl_complete',
    $sql$
      SELECT NOT EXISTS (
        SELECT 1
        FROM public.loan_types lt
        JOIN public.employee_loans el
          ON el.loan_type_id = lt.id
         AND el.status = 'active'
        WHERE lt.organization_id = $1
          AND lt.is_active = true
          AND (lt.gl_receivable_account_id IS NULL
               OR lt.gl_disbursement_clearing_account_id IS NULL)
      )
    $sql$,
    'Map loan-type GL accounts',
    '/hr/payroll/loan-types',
    310
  ),
  (
    NULL,
    'loan.schedule_present',
    'Loan repayment schedules generated',
    'Every active loan whose type requires a schedule must have at least one loan_repayment_schedule row before the run can deduct it.',
    'org', 'block', 'core', 'LOAN_SCHEDULE_MISSING',
    'loan.schedule_present',
    $sql$
      SELECT NOT EXISTS (
        SELECT 1
        FROM public.employee_loans el
        JOIN public.loan_types lt ON lt.id = el.loan_type_id
        WHERE el.organization_id = $1
          AND el.status = 'active'
          AND COALESCE(lt.requires_schedule, false) = true
          AND NOT EXISTS (
            SELECT 1 FROM public.loan_repayment_schedule s
            WHERE s.loan_id = el.id
          )
      )
    $sql$,
    'Generate loan schedules',
    '/hr/payroll/loans',
    320
  ),
  (
    NULL,
    'loan_type.writeoff_account_present',
    'Write-off account mapped for loan types with write-offs',
    'When a loan is at write-off status, either the loan type or default_account_settings must supply the write-off expense account.',
    'org', 'warn', 'core', 'LOAN_WRITEOFF_ACCOUNT_MISSING',
    'loan_type.writeoff_account_present',
    $sql$
      SELECT NOT EXISTS (
        SELECT 1
        FROM public.employee_loans el
        JOIN public.loan_types lt ON lt.id = el.loan_type_id
        WHERE el.organization_id = $1
          AND el.status = 'written_off'
          AND lt.writeoff_account_id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM public.default_account_settings d
            WHERE d.organization_id = $1
              AND d.setting_key IN ('loan_writeoff_expense','salary_expense')
              AND d.account_id IS NOT NULL
          )
      )
    $sql$,
    'Map write-off expense account',
    '/hr/payroll/account-mapping',
    330
  )
ON CONFLICT (organization_id, code) DO UPDATE SET
  name              = EXCLUDED.name,
  description       = EXCLUDED.description,
  predicate_sql     = EXCLUDED.predicate_sql,
  remediation_label = EXCLUDED.remediation_label,
  remediation_link  = EXCLUDED.remediation_link,
  sort_order        = EXCLUDED.sort_order,
  updated_at        = now();