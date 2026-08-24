ALTER TABLE public.crm_leads
  ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES public.branches(id) ON DELETE RESTRICT;

UPDATE public.crm_leads l
   SET branch_id = public.get_default_branch_id(l.business_id)
 WHERE l.branch_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_crm_leads_branch ON public.crm_leads (business_id, branch_id);

DROP TRIGGER IF EXISTS crm_leads_branch_business_match ON public.crm_leads;
CREATE TRIGGER crm_leads_branch_business_match
  BEFORE INSERT OR UPDATE OF branch_id, business_id ON public.crm_leads
  FOR EACH ROW EXECUTE FUNCTION public.validate_branch_business_match();