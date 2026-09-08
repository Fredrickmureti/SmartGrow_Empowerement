DROP POLICY IF EXISTS mf_loan_products_read ON public.mf_loan_products;
CREATE POLICY mf_loan_products_read ON public.mf_loan_products FOR SELECT TO authenticated
USING (public.mf_can(business_id, NULL::uuid, 'loan_products', 'read'));

DROP POLICY IF EXISTS mf_lpv_read ON public.mf_loan_product_versions;
CREATE POLICY mf_lpv_read ON public.mf_loan_product_versions FOR SELECT TO authenticated
USING (public.mf_can(business_id, NULL::uuid, 'loan_products', 'read'));

DROP POLICY IF EXISTS mf_assess_read ON public.mf_application_assessments;
CREATE POLICY mf_assess_read ON public.mf_application_assessments FOR SELECT TO authenticated
USING (public.mf_can(business_id, NULL::uuid, 'applications', 'read'));

DROP POLICY IF EXISTS mf_assess_insert ON public.mf_application_assessments;
CREATE POLICY mf_assess_insert ON public.mf_application_assessments FOR INSERT TO authenticated
WITH CHECK (public.mf_can(business_id, NULL::uuid, 'applications', 'write') AND assessed_by = auth.uid());

DROP POLICY IF EXISTS mf_account_mappings_read ON public.mf_account_mappings;
CREATE POLICY mf_account_mappings_read ON public.mf_account_mappings FOR SELECT TO authenticated
USING (public.mf_can(business_id, NULL::uuid, 'accounting', 'read'));

DROP POLICY IF EXISTS mf_allocation_policy_read ON public.mf_allocation_policy;
CREATE POLICY mf_allocation_policy_read ON public.mf_allocation_policy FOR SELECT TO authenticated
USING (public.mf_can(business_id, NULL::uuid, 'accounting', 'read'));

DROP POLICY IF EXISTS mf_event_postings_read_institution ON public.mf_event_postings;
CREATE POLICY mf_event_postings_read_institution ON public.mf_event_postings FOR SELECT TO authenticated
USING (public.mf_can(business_id, NULL::uuid, 'accounting', 'read'));