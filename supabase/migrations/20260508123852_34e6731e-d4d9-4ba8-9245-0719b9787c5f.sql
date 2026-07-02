-- Remove the legacy payroll separation-of-duties trigger that referenced a non-existent
-- permission_groups.payroll_role column. The canonical enforcement now lives in
-- enforce_payroll_maker_checker() (policy-aware) plus user_has_module_permission()
-- via Access Groups. This unblocks approval for admins/owners and any user granted
-- payroll.approve via access groups.

DROP TRIGGER IF EXISTS trg_payroll_runs_sod ON public.payroll_runs;
DROP FUNCTION IF EXISTS public.enforce_payroll_separation_of_duties() CASCADE;
DROP FUNCTION IF EXISTS public.user_payroll_role(uuid, uuid) CASCADE;