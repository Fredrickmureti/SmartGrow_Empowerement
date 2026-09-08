DROP POLICY IF EXISTS mf_loan_charges_read ON public.mf_loan_charges;
CREATE POLICY mf_loan_charges_read ON public.mf_loan_charges FOR SELECT TO authenticated
USING (public.mf_can(business_id, NULL::uuid, 'loans', 'read') AND public.mf_loan_in_scope(loan_id));

DROP POLICY IF EXISTS mf_loan_disb_read ON public.mf_loan_disbursements;
CREATE POLICY mf_loan_disb_read ON public.mf_loan_disbursements FOR SELECT TO authenticated
USING (public.mf_can(business_id, NULL::uuid, 'loans', 'read') AND public.mf_loan_in_scope(loan_id));

DROP POLICY IF EXISTS mf_loan_events_read ON public.mf_loan_events;
CREATE POLICY mf_loan_events_read ON public.mf_loan_events FOR SELECT TO authenticated
USING (public.mf_can(business_id, NULL::uuid, 'loans', 'read') AND public.mf_loan_in_scope(loan_id));

DROP POLICY IF EXISTS mf_loan_schedule_read ON public.mf_loan_schedule;
CREATE POLICY mf_loan_schedule_read ON public.mf_loan_schedule FOR SELECT TO authenticated
USING (public.mf_can(business_id, NULL::uuid, 'loans', 'read') AND public.mf_loan_in_scope(loan_id));

DROP POLICY IF EXISTS mf_repayment_allocations_read ON public.mf_repayment_allocations;
CREATE POLICY mf_repayment_allocations_read ON public.mf_repayment_allocations FOR SELECT TO authenticated
USING (public.mf_can(business_id, NULL::uuid, 'repayments', 'read') AND public.mf_loan_in_scope(loan_id));

DROP POLICY IF EXISTS "Staff can view collection bankings in scope" ON public.mf_collection_bankings;
CREATE POLICY "Staff can view collection bankings in scope" ON public.mf_collection_bankings FOR SELECT TO authenticated
USING (
  public.mf_can(business_id, NULL::uuid, 'repayments', 'read')
  AND EXISTS (
    SELECT 1 FROM public.mf_repayment_batches b
    WHERE b.id = mf_collection_bankings.batch_id
      AND b.business_id = mf_collection_bankings.business_id
      AND public.mf_officer_in_scope(b.collected_by)
  )
);