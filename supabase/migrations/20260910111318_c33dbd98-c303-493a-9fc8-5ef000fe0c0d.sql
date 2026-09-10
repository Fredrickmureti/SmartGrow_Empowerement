CREATE OR REPLACE FUNCTION public.mf_delete_loan_product(p_product_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  p public.mf_loan_products%ROWTYPE;
  v_org uuid;
  v_published integer;
  v_apps integer;
  v_loans integer;
  v_versions integer;
BEGIN
  SELECT * INTO p FROM public.mf_loan_products WHERE id = p_product_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That loan product no longer exists';
  END IF;
  IF NOT public.mf_can(p.business_id, NULL, 'loan_products', 'delete') THEN
    RAISE EXCEPTION 'You are not authorised to delete loan products';
  END IF;

  SELECT count(*) INTO v_loans FROM public.mf_loans WHERE product_id = p.id;
  IF v_loans > 0 THEN
    RAISE EXCEPTION 'This product has been lent on (% loan(s)) — retire it instead of deleting it', v_loans;
  END IF;

  SELECT count(*) INTO v_apps FROM public.mf_loan_applications WHERE product_id = p.id;
  IF v_apps > 0 THEN
    RAISE EXCEPTION 'This product is used by % application(s) — retire it instead of deleting it', v_apps;
  END IF;

  SELECT count(*) INTO v_published FROM public.mf_loan_product_versions
   WHERE product_id = p.id AND is_published;
  IF v_published > 0 AND p.status <> 'retired' THEN
    RAISE EXCEPTION 'This product has been published to the institution''s offer — retire it first, then it can be deleted';
  END IF;

  SELECT count(*) INTO v_versions FROM public.mf_loan_product_versions WHERE product_id = p.id;

  SELECT organization_id INTO v_org FROM public.businesses WHERE id = p.business_id;
  INSERT INTO public.audit_logs (organization_id, business_id, user_id, action, entity_type, entity_id, entity_name, old_values, changes_summary)
  VALUES (v_org, p.business_id, auth.uid(), 'delete', 'mf_loan_product', p.id, p.code,
          to_jsonb(p),
          format('Unused loan product deleted (%s version(s), %s published, status %s)', v_versions, v_published, p.status));

  PERFORM set_config('app.mf_product_purge', 'on', true);
  UPDATE public.mf_loan_products SET current_version_id = NULL WHERE id = p.id;
  DELETE FROM public.mf_loan_product_versions WHERE product_id = p.id;
  DELETE FROM public.mf_loan_products WHERE id = p.id;
  PERFORM set_config('app.mf_product_purge', '', true);
  RETURN p.id;
END;
$function$;