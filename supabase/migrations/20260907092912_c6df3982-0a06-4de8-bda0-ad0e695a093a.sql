CREATE OR REPLACE FUNCTION public.sod_mf_loans_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_subject uuid := OLD.created_by;
  v_org uuid;
  v_action text;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;
  IF v_subject IS NULL THEN
    RETURN NEW;
  END IF;

  v_action := CASE
    WHEN OLD.status = 'pending_disbursement' AND NEW.status = 'active' THEN
      CASE WHEN OLD.lineage_kind = 'restructure' THEN 'loan.restructure' ELSE 'loan.disburse' END
    WHEN NEW.status = 'written_off' THEN 'loan.write_off'
    ELSE NULL
  END;

  IF v_action IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT organization_id INTO v_org FROM public.businesses WHERE id = NEW.business_id;

  PERFORM public.governance_assert_not_self(
    v_actor, v_subject, v_action, v_org, 'mf_loan', NEW.id
  );

  RETURN NEW;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.sod_mf_loans_guard() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.sod_mf_loan_applications_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS sod_mf_loans_guard ON public.mf_loans;
CREATE TRIGGER sod_mf_loans_guard
BEFORE UPDATE ON public.mf_loans
FOR EACH ROW EXECUTE FUNCTION public.sod_mf_loans_guard();