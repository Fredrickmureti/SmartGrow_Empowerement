CREATE OR REPLACE FUNCTION public.change_business_base_currency(
  p_business_id uuid,
  p_new_currency text,
  p_reason text,
  p_confirm_impacts boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_business public.businesses%ROWTYPE;
  v_new_currency text;
  v_reason text;
  v_readiness jsonb;
  v_drafts jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT public.user_can_access_business(auth.uid(), p_business_id) THEN
    RAISE EXCEPTION 'Not authorised for this company' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_business FROM public.businesses WHERE id = p_business_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Company not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT public.is_finance_manager(auth.uid(), v_business.organization_id) THEN
    RAISE EXCEPTION 'Changing base currency requires a finance role (owner, admin or accountant)' USING ERRCODE = '42501';
  END IF;

  v_new_currency := public.normalize_currency_code(p_new_currency);
  v_reason := NULLIF(btrim(COALESCE(p_reason,'')), '');
  IF v_new_currency IS NULL OR NOT EXISTS (SELECT 1 FROM public.currencies WHERE code=v_new_currency AND is_active) THEN
    RAISE EXCEPTION 'Choose an active currency' USING ERRCODE = '22023';
  END IF;
  IF v_reason IS NULL THEN RAISE EXCEPTION 'A reason is required' USING ERRCODE = '22023'; END IF;
  IF v_new_currency = upper(v_business.base_currency) THEN RAISE EXCEPTION 'The selected currency is already the base currency' USING ERRCODE = '22023'; END IF;

  v_readiness := public.business_currency_readiness(p_business_id);
  IF NOT (v_readiness->>'can_change')::boolean THEN
    RAISE EXCEPTION 'Base currency is locked because accounting entries already exist' USING ERRCODE = '23514';
  END IF;
  IF (v_readiness->>'requires_confirmation')::boolean AND NOT p_confirm_impacts THEN
    RAISE EXCEPTION 'Review and confirm the affected drafts and currency settings before changing base currency' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.businesses SET base_currency=v_new_currency WHERE id=p_business_id;

  UPDATE public.invoices d SET exchange_rate=(SELECT s.rate FROM public.fx_stamp_document(d.organization_id,d.business_id,d.currency,d.issue_date) s) WHERE d.business_id=p_business_id AND d.status::text='draft';
  UPDATE public.bills d SET currency_rate=(SELECT s.rate FROM public.fx_stamp_document(d.organization_id,d.business_id,d.currency,d.bill_date) s), company_currency_total=round(coalesce(d.total,0)*(SELECT s.rate FROM public.fx_stamp_document(d.organization_id,d.business_id,d.currency,d.bill_date) s),2) WHERE d.business_id=p_business_id AND d.status::text='draft';
  UPDATE public.estimates d SET exchange_rate=(SELECT s.rate FROM public.fx_stamp_document(d.organization_id,d.business_id,d.currency,d.issue_date) s) WHERE d.business_id=p_business_id AND d.status::text='draft';
  UPDATE public.sales_orders d SET exchange_rate=(SELECT s.rate FROM public.fx_stamp_document(d.organization_id,d.business_id,d.currency,d.order_date) s) WHERE d.business_id=p_business_id AND d.status::text='draft';
  UPDATE public.purchase_orders d SET exchange_rate=(SELECT s.rate FROM public.fx_stamp_document(d.organization_id,d.business_id,d.currency,d.order_date) s) WHERE d.business_id=p_business_id AND d.status::text='draft';
  UPDATE public.credit_notes d SET exchange_rate=(SELECT s.rate FROM public.fx_stamp_document(d.organization_id,d.business_id,d.currency,d.issue_date) s) WHERE d.business_id=p_business_id AND d.status::text='draft';
  UPDATE public.vendor_credit_notes d SET exchange_rate=(SELECT s.rate FROM public.fx_stamp_document(d.organization_id,d.business_id,d.currency,d.credit_date) s) WHERE d.business_id=p_business_id AND d.status::text='draft';
  UPDATE public.customer_refunds d SET exchange_rate=(SELECT s.rate FROM public.fx_stamp_document(d.organization_id,d.business_id,d.currency,d.refund_date) s) WHERE d.business_id=p_business_id AND d.status::text='draft';
  UPDATE public.expenses d SET exchange_rate=(SELECT s.rate FROM public.fx_stamp_document(d.organization_id,d.business_id,d.currency,d.expense_date) s), base_amount=round(coalesce(d.amount,0)*(SELECT s.rate FROM public.fx_stamp_document(d.organization_id,d.business_id,d.currency,d.expense_date) s),2) WHERE d.business_id=p_business_id AND d.status::text='draft';

  v_drafts := v_readiness->'draft_counts';
  INSERT INTO public.business_currency_change_audit (organization_id,business_id,actor_id,old_currency,new_currency,reason,draft_counts,impact_snapshot)
  VALUES (v_business.organization_id,p_business_id,auth.uid(),upper(v_business.base_currency),v_new_currency,v_reason,v_drafts,v_readiness);

  INSERT INTO public.audit_logs (organization_id,business_id,user_id,action,entity_type,entity_id,entity_name,new_values,changes_summary)
  VALUES (v_business.organization_id,p_business_id,auth.uid(),'business.base_currency.changed','business',p_business_id,v_business.name,jsonb_build_object('old_currency',upper(v_business.base_currency),'new_currency',v_new_currency,'draft_counts',v_drafts),v_reason);

  RETURN jsonb_build_object('old_currency',upper(v_business.base_currency),'new_currency',v_new_currency,'draft_counts',v_drafts);
END;
$$;

REVOKE ALL ON FUNCTION public.change_business_base_currency(uuid,text,text,boolean) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.change_business_base_currency(uuid,text,text,boolean) TO authenticated;