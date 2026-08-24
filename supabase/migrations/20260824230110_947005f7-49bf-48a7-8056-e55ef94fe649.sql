ALTER TABLE public.crm_stages
  ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES public.branches(id) ON DELETE RESTRICT;

ALTER TABLE public.crm_lost_reasons
  ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES public.branches(id) ON DELETE RESTRICT;

DROP TRIGGER IF EXISTS crm_stages_branch_business_match ON public.crm_stages;
CREATE TRIGGER crm_stages_branch_business_match
  BEFORE INSERT OR UPDATE OF branch_id, business_id ON public.crm_stages
  FOR EACH ROW EXECUTE FUNCTION public.validate_branch_business_match();

DROP TRIGGER IF EXISTS crm_lost_reasons_branch_business_match ON public.crm_lost_reasons;
CREATE TRIGGER crm_lost_reasons_branch_business_match
  BEFORE INSERT OR UPDATE OF branch_id, business_id ON public.crm_lost_reasons
  FOR EACH ROW EXECUTE FUNCTION public.validate_branch_business_match();

REVOKE EXECUTE ON FUNCTION public._crm_activity_branch_from_lead() FROM PUBLIC, anon, authenticated;