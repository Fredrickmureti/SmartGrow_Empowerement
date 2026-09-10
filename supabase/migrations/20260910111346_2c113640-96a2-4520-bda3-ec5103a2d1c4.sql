CREATE OR REPLACE FUNCTION public.mf_delete_loan_application(p_application_id uuid, p_reason text DEFAULT NULL)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  a public.mf_loan_applications%ROWTYPE;
  v_loan text;
  v_org uuid;
  v_assessments integer;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
BEGIN
  SELECT * INTO a FROM public.mf_loan_applications WHERE id = p_application_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That application no longer exists';
  END IF;

  IF NOT public.mf_can_scoped(a.business_id, a.branch_id, 'applications', 'delete', a.loan_officer_id) THEN
    RAISE EXCEPTION 'You are not authorised to delete loan applications';
  END IF;

  SELECT loan_number INTO v_loan FROM public.mf_loans WHERE application_id = a.id LIMIT 1;
  IF v_loan IS NOT NULL THEN
    RAISE EXCEPTION 'This application has produced loan % and is part of lending history — it cannot be deleted', v_loan;
  END IF;

  SELECT organization_id INTO v_org FROM public.businesses WHERE id = a.business_id;

  IF a.status = 'rejected' THEN
    IF NOT public.is_org_admin(auth.uid(), v_org) THEN
      RAISE EXCEPTION 'Only an administrator can delete a declined application';
    END IF;
    IF v_reason IS NULL THEN
      RAISE EXCEPTION 'A reason is required to delete a declined application';
    END IF;
  ELSIF a.status NOT IN ('draft', 'cancelled') THEN
    RAISE EXCEPTION 'Only a draft or withdrawn application can be deleted — this one is %. Withdraw or decline it instead', a.status;
  END IF;

  SELECT count(*) INTO v_assessments FROM public.mf_application_assessments WHERE application_id = a.id;

  INSERT INTO public.audit_logs (organization_id, business_id, user_id, action, entity_type, entity_id, entity_name, old_values, changes_summary)
  VALUES (v_org, a.business_id, auth.uid(), 'delete', 'mf_loan_application', a.id, a.application_number,
          to_jsonb(a),
          format('Loan application deleted (%s, %s assessment record(s))%s', a.status, v_assessments,
                 CASE WHEN v_reason IS NULL THEN '' ELSE ' — reason: ' || v_reason END));

  DELETE FROM public.mf_loan_applications WHERE id = a.id;
  RETURN a.id;
END;
$function$;