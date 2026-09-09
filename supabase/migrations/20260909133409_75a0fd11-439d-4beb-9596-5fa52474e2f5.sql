ALTER TABLE public.mf_repayment_batches
  ADD COLUMN meeting_id uuid REFERENCES public.mf_group_meetings(id) ON DELETE SET NULL;
ALTER TABLE public.mf_clients
  ADD COLUMN onboarded_meeting_id uuid REFERENCES public.mf_group_meetings(id) ON DELETE SET NULL;
ALTER TABLE public.mf_loan_applications
  ADD COLUMN meeting_id uuid REFERENCES public.mf_group_meetings(id) ON DELETE SET NULL;

CREATE OR REPLACE FUNCTION public._mf_meeting_link_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_meeting uuid;
  v_business uuid;
BEGIN
  IF TG_TABLE_NAME = 'mf_clients' THEN
    v_meeting := NEW.onboarded_meeting_id;
  ELSE
    v_meeting := NEW.meeting_id;
  END IF;

  IF v_meeting IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT business_id INTO v_business FROM public.mf_group_meetings WHERE id = v_meeting;
  IF v_business IS NULL THEN
    RAISE EXCEPTION 'The meeting referenced by this record does not exist';
  END IF;
  IF v_business IS DISTINCT FROM NEW.business_id THEN
    RAISE EXCEPTION 'This record cannot be linked to a meeting from another business';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER mf_repayment_batches_meeting_link
  BEFORE INSERT OR UPDATE ON public.mf_repayment_batches
  FOR EACH ROW EXECUTE FUNCTION public._mf_meeting_link_guard();

CREATE TRIGGER mf_clients_meeting_link
  BEFORE INSERT OR UPDATE ON public.mf_clients
  FOR EACH ROW EXECUTE FUNCTION public._mf_meeting_link_guard();

CREATE TRIGGER mf_loan_applications_meeting_link
  BEFORE INSERT OR UPDATE ON public.mf_loan_applications
  FOR EACH ROW EXECUTE FUNCTION public._mf_meeting_link_guard();