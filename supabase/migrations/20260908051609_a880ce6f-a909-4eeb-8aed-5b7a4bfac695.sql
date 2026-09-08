CREATE OR REPLACE FUNCTION public.sod_mf_loan_disbursements_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := COALESCE(auth.uid(), NEW.disbursed_by);
  v_approver uuid;
  v_org uuid;
BEGIN
  SELECT a.decision_by
    INTO v_approver
    FROM public.mf_loans l
    JOIN public.mf_loan_applications a ON a.id = l.application_id
   WHERE l.id = NEW.loan_id;

  IF v_approver IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT b.organization_id INTO v_org
    FROM public.businesses b WHERE b.id = NEW.business_id;

  PERFORM public.governance_assert_not_self(
    v_actor, v_approver, 'loan.disburse', v_org, 'mf_loan_disbursement', NEW.id
  );

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS sod_mf_loan_disbursements_guard ON public.mf_loan_disbursements;
CREATE TRIGGER sod_mf_loan_disbursements_guard
BEFORE INSERT ON public.mf_loan_disbursements
FOR EACH ROW EXECUTE FUNCTION public.sod_mf_loan_disbursements_guard();