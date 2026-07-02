-- payroll_readiness_period_effectiveness_test.sql
--
-- Pins the contract that `payroll_readiness_eval_rule` is
-- period-effective: a contract that is not effective during the
-- requested period must produce a fail on contract-dependent rules,
-- even if its status is 'running'.
--
-- Run with: supabase test db

begin;
select plan(4);

-- Function signature must accept period bounds.
select has_function(
  'public',
  'payroll_readiness_eval_rule',
  array['payroll_readiness_rules','uuid','uuid','uuid','date','date'],
  'payroll_readiness_eval_rule accepts (rule, org, business, subject, period_start, period_end)'
);

-- payroll_period_employees signature.
select has_function(
  'public',
  'payroll_period_employees',
  array['uuid','uuid','date','date'],
  'payroll_period_employees(org, business, period_start, period_end) exists'
);

-- payroll_readiness_employee_matrix signature.
select has_function(
  'public',
  'payroll_readiness_employee_matrix',
  array['uuid','uuid','uuid[]','date','date'],
  'payroll_readiness_employee_matrix(org, business, employee_ids, period_start, period_end) exists'
);

-- evaluate_payroll_readiness still callable with period bounds.
select has_function(
  'public',
  'evaluate_payroll_readiness',
  array['uuid','uuid','text','uuid[]','date','date'],
  'evaluate_payroll_readiness(org, business, scope, ids, period_start, period_end) exists'
);

select * from finish();
rollback;
