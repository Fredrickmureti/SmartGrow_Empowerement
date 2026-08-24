ALTER TABLE public.crm_leads DROP CONSTRAINT IF EXISTS crm_leads_stage_id_fkey;
ALTER TABLE public.crm_leads ADD CONSTRAINT crm_leads_business_stage_fkey FOREIGN KEY (business_id, stage_id) REFERENCES public.crm_stages (business_id, id) ON DELETE SET NULL (stage_id);

ALTER TABLE public.crm_leads DROP CONSTRAINT IF EXISTS crm_leads_contact_id_fkey;
ALTER TABLE public.crm_leads ADD CONSTRAINT crm_leads_business_contact_fkey FOREIGN KEY (business_id, contact_id) REFERENCES public.contacts (business_id, id) ON DELETE SET NULL (contact_id);

ALTER TABLE public.crm_leads DROP CONSTRAINT IF EXISTS crm_leads_company_contact_id_fkey;
ALTER TABLE public.crm_leads ADD CONSTRAINT crm_leads_business_company_contact_fkey FOREIGN KEY (business_id, company_contact_id) REFERENCES public.contacts (business_id, id) ON DELETE SET NULL (company_contact_id);

ALTER TABLE public.crm_leads DROP CONSTRAINT IF EXISTS crm_leads_lost_reason_id_fkey;
ALTER TABLE public.crm_leads ADD CONSTRAINT crm_leads_business_lost_reason_fkey FOREIGN KEY (business_id, lost_reason_id) REFERENCES public.crm_lost_reasons (business_id, id) ON DELETE RESTRICT;

ALTER TABLE public.crm_leads DROP CONSTRAINT IF EXISTS crm_leads_branch_id_fkey;
ALTER TABLE public.crm_leads ADD CONSTRAINT crm_leads_business_branch_fkey FOREIGN KEY (business_id, branch_id) REFERENCES public.branches (business_id, id) ON DELETE RESTRICT;