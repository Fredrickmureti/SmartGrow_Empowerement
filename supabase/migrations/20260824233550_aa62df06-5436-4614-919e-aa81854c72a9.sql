ALTER TABLE public.crm_stages ADD CONSTRAINT crm_stages_business_id_id_key UNIQUE (business_id, id);
ALTER TABLE public.crm_lost_reasons ADD CONSTRAINT crm_lost_reasons_business_id_id_key UNIQUE (business_id, id);
ALTER TABLE public.contacts ADD CONSTRAINT contacts_business_id_id_key UNIQUE (business_id, id);
ALTER TABLE public.branches ADD CONSTRAINT branches_business_id_id_key UNIQUE (business_id, id);