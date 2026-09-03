DROP POLICY IF EXISTS mf_apps_read ON public.mf_loan_applications;
CREATE POLICY mf_apps_read ON public.mf_loan_applications
FOR SELECT TO authenticated
USING (user_has_business_access(auth.uid(), business_id) AND public.mf_officer_in_scope(loan_officer_id));

DROP POLICY IF EXISTS mf_groups_read ON public.mf_groups;
CREATE POLICY mf_groups_read ON public.mf_groups
FOR SELECT TO authenticated
USING (user_has_business_access(auth.uid(), business_id) AND public.mf_officer_in_scope(loan_officer_id));

DROP POLICY IF EXISTS mf_loan_schedule_read ON public.mf_loan_schedule;
CREATE POLICY mf_loan_schedule_read ON public.mf_loan_schedule
FOR SELECT TO authenticated
USING (user_has_business_access(auth.uid(), business_id) AND public.mf_loan_in_scope(loan_id));

DROP POLICY IF EXISTS mf_loan_disb_read ON public.mf_loan_disbursements;
CREATE POLICY mf_loan_disb_read ON public.mf_loan_disbursements
FOR SELECT TO authenticated
USING (user_has_business_access(auth.uid(), business_id) AND public.mf_loan_in_scope(loan_id));

DROP POLICY IF EXISTS mf_loan_events_read ON public.mf_loan_events;
CREATE POLICY mf_loan_events_read ON public.mf_loan_events
FOR SELECT TO authenticated
USING (user_has_business_access(auth.uid(), business_id) AND public.mf_loan_in_scope(loan_id));

DROP POLICY IF EXISTS mf_repayment_allocations_read ON public.mf_repayment_allocations;
CREATE POLICY mf_repayment_allocations_read ON public.mf_repayment_allocations
FOR SELECT TO authenticated
USING (user_has_business_access(auth.uid(), business_id) AND public.mf_loan_in_scope(loan_id));