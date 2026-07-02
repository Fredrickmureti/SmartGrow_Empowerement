DROP FUNCTION IF EXISTS public.employee_payroll_readiness(uuid);
DROP FUNCTION IF EXISTS public.payroll_readiness_blockers(uuid, uuid, text, uuid);
DROP FUNCTION IF EXISTS public.payroll_readiness_eval_rule_ext(public.payroll_readiness_rules, uuid, uuid, uuid, date, date);