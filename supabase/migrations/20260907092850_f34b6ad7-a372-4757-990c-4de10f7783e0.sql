CREATE OR REPLACE FUNCTION public.sod_mf_loan_applications_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_subject uuid := COALESCE(OLD.submitted_by, OLD.created_by);
  v_org uuid;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;
  IF NEW.status NOT IN ('approved', 'rejected') THEN
    RETURN NEW;
  END IF;
  IF v_subject IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT organization_id INTO v_org FROM public.businesses WHERE id = NEW.business_id;

  PERFORM public.governance_assert_not_self(
    COALESCE(NEW.decision_by, v_actor),
    v_subject,
    'loan.approve',
    v_org,
    'mf_loan_application',
    NEW.id
  );

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS sod_mf_loan_applications_guard ON public.mf_loan_applications;
CREATE TRIGGER sod_mf_loan_applications_guard
BEFORE UPDATE ON public.mf_loan_applications
FOR EACH ROW EXECUTE FUNCTION public.sod_mf_loan_applications_guard();