DROP VIEW IF EXISTS public.employee_loan_state_transitions;
ALTER VIEW public.v_branch_scoped_policy_check SET (security_invoker = true);
ALTER VIEW public.v_business_event_outbox_health SET (security_invoker = true);
ALTER VIEW public.v_employee_branch_scope SET (security_invoker = true);
ALTER VIEW public.v_fiscal_workspace_health SET (security_invoker = true);