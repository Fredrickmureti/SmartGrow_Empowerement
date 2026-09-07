CREATE OR REPLACE FUNCTION public.sod_mf_repayments_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := COALESCE(NEW.reversed_by, auth.uid());
  v_subject uuid := COALESCE(OLD.received_by, OLD.created_by);
  v_org uuid;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status OR NEW.status <> 'reversed' THEN
    RETURN NEW;
  END IF;
  IF v_subject IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT organization_id INTO v_org FROM public.businesses WHERE id = NEW.business_id;

  PERFORM public.governance_assert_not_self(
    v_actor, v_subject, 'repayment.reverse', v_org, 'mf_repayment', NEW.id
  );

  RETURN NEW;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.sod_mf_repayments_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS sod_mf_repayments_guard ON public.mf_repayments;
CREATE TRIGGER sod_mf_repayments_guard
BEFORE UPDATE ON public.mf_repayments
FOR EACH ROW EXECUTE FUNCTION public.sod_mf_repayments_guard();