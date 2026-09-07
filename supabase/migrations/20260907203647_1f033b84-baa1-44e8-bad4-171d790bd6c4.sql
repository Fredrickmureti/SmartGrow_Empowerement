DROP FUNCTION IF EXISTS public.tg_employee_loan_autogenerate_schedule() CASCADE;
DROP FUNCTION IF EXISTS public.generate_loan_schedule(uuid) CASCADE;
DROP FUNCTION IF EXISTS public._loan_deallocate_schedule(uuid) CASCADE;
DROP TABLE IF EXISTS public.loan_repayment_schedule CASCADE;
DROP TABLE IF EXISTS public.loan_repayments CASCADE;