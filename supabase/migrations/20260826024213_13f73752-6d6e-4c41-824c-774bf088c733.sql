CREATE TABLE public.business_currency_change_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  business_id uuid NOT NULL REFERENCES public.businesses(id),
  actor_id uuid NOT NULL,
  old_currency text NOT NULL,
  new_currency text NOT NULL,
  reason text NOT NULL,
  draft_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  impact_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.business_currency_change_audit TO authenticated;
GRANT ALL ON public.business_currency_change_audit TO service_role;

ALTER TABLE public.business_currency_change_audit ENABLE ROW LEVEL SECURITY;

CREATE POLICY business_currency_change_audit_select
ON public.business_currency_change_audit
FOR SELECT TO authenticated
USING (
  public.user_can_access_business(auth.uid(), business_id)
  AND public.is_finance_manager(auth.uid(), organization_id)
);

CREATE INDEX business_currency_change_audit_business_created_idx
ON public.business_currency_change_audit (business_id, created_at DESC);

CREATE OR REPLACE FUNCTION public._business_currency_audit_append_only()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  RAISE EXCEPTION 'Base-currency change history is append-only' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER trg_business_currency_change_audit_append_only
BEFORE UPDATE OR DELETE ON public.business_currency_change_audit
FOR EACH ROW EXECUTE FUNCTION public._business_currency_audit_append_only();

REVOKE ALL ON FUNCTION public._business_currency_audit_append_only() FROM public, anon, authenticated;

CREATE OR REPLACE FUNCTION public.business_currency_readiness(p_business_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_business public.businesses%ROWTYPE;
  v_journal_entries bigint;
  v_foreign_bank_accounts bigint;
  v_non_base_currencies bigint;
  v_reconciliations bigint;
  v_closed_periods bigint;
  v_drafts jsonb;
  v_draft_total bigint;
BEGIN
  IF auth.uid() IS NULL OR NOT public.user_can_access_business(auth.uid(), p_business_id) THEN
    RAISE EXCEPTION 'Not authorised for this company' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_business FROM public.businesses WHERE id = p_business_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Company not found' USING ERRCODE = 'P0002'; END IF;

  SELECT count(*) INTO v_journal_entries FROM public.journal_entries WHERE business_id = p_business_id;
  SELECT count(*) INTO v_foreign_bank_accounts FROM public.bank_accounts
   WHERE business_id = p_business_id AND upper(currency) <> upper(v_business.base_currency);
  SELECT count(*) INTO v_non_base_currencies FROM public.business_active_currencies
   WHERE business_id = p_business_id AND is_enabled AND currency_code <> upper(v_business.base_currency);
  SELECT count(*) INTO v_reconciliations FROM public.bank_reconciliation_sessions
   WHERE business_id = p_business_id AND status NOT IN ('draft', 'cancelled');
  SELECT count(*) INTO v_closed_periods FROM public.fiscal_periods
   WHERE business_id = p_business_id AND status <> 'open';

  v_drafts := jsonb_build_object(
    'invoices', (SELECT count(*) FROM public.invoices WHERE business_id=p_business_id AND status::text='draft'),
    'bills', (SELECT count(*) FROM public.bills WHERE business_id=p_business_id AND status::text='draft'),
    'estimates', (SELECT count(*) FROM public.estimates WHERE business_id=p_business_id AND status::text='draft'),
    'sales_orders', (SELECT count(*) FROM public.sales_orders WHERE business_id=p_business_id AND status::text='draft'),
    'purchase_orders', (SELECT count(*) FROM public.purchase_orders WHERE business_id=p_business_id AND status::text='draft'),
    'credit_notes', (SELECT count(*) FROM public.credit_notes WHERE business_id=p_business_id AND status::text='draft'),
    'vendor_credit_notes', (SELECT count(*) FROM public.vendor_credit_notes WHERE business_id=p_business_id AND status::text='draft'),
    'customer_refunds', (SELECT count(*) FROM public.customer_refunds WHERE business_id=p_business_id AND status::text='draft'),
    'expenses', (SELECT count(*) FROM public.expenses WHERE business_id=p_business_id AND status::text='draft')
  );
  SELECT COALESCE(sum(value::text::bigint),0) INTO v_draft_total FROM jsonb_each(v_drafts);

  RETURN jsonb_build_object(
    'business_id', p_business_id,
    'current_currency', upper(v_business.base_currency),
    'state', CASE WHEN v_journal_entries > 0 THEN 'locked' WHEN v_draft_total+v_foreign_bank_accounts+v_non_base_currencies+v_reconciliations+v_closed_periods > 0 THEN 'confirmation_required' ELSE 'ready' END,
    'can_change', v_journal_entries = 0,
    'requires_confirmation', v_draft_total+v_foreign_bank_accounts+v_non_base_currencies+v_reconciliations+v_closed_periods > 0,
    'journal_entry_count', v_journal_entries,
    'draft_total', v_draft_total,
    'draft_counts', v_drafts,
    'foreign_bank_account_count', v_foreign_bank_accounts,
    'non_base_operating_currency_count', v_non_base_currencies,
    'reconciliation_count', v_reconciliations,
    'closed_period_count', v_closed_periods
  );
END;
$$;

REVOKE ALL ON FUNCTION public.business_currency_readiness(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.business_currency_readiness(uuid) TO authenticated;

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

  UPDATE public.invoices d SET exchange_rate=s.rate FROM LATERAL public.fx_stamp_document(d.organization_id,d.business_id,d.currency,d.issue_date) s WHERE d.business_id=p_business_id AND d.status::text='draft';
  UPDATE public.bills d SET currency_rate=s.rate, company_currency_total=round(coalesce(d.total,0)*s.rate,2) FROM LATERAL public.fx_stamp_document(d.organization_id,d.business_id,d.currency,d.bill_date) s WHERE d.business_id=p_business_id AND d.status::text='draft';
  UPDATE public.estimates d SET exchange_rate=s.rate FROM LATERAL public.fx_stamp_document(d.organization_id,d.business_id,d.currency,d.issue_date) s WHERE d.business_id=p_business_id AND d.status::text='draft';
  UPDATE public.sales_orders d SET exchange_rate=s.rate FROM LATERAL public.fx_stamp_document(d.organization_id,d.business_id,d.currency,d.order_date) s WHERE d.business_id=p_business_id AND d.status::text='draft';
  UPDATE public.purchase_orders d SET exchange_rate=s.rate FROM LATERAL public.fx_stamp_document(d.organization_id,d.business_id,d.currency,d.order_date) s WHERE d.business_id=p_business_id AND d.status::text='draft';
  UPDATE public.credit_notes d SET exchange_rate=s.rate FROM LATERAL public.fx_stamp_document(d.organization_id,d.business_id,d.currency,d.issue_date) s WHERE d.business_id=p_business_id AND d.status::text='draft';
  UPDATE public.vendor_credit_notes d SET exchange_rate=s.rate FROM LATERAL public.fx_stamp_document(d.organization_id,d.business_id,d.currency,d.credit_date) s WHERE d.business_id=p_business_id AND d.status::text='draft';
  UPDATE public.customer_refunds d SET exchange_rate=s.rate FROM LATERAL public.fx_stamp_document(d.organization_id,d.business_id,d.currency,d.refund_date) s WHERE d.business_id=p_business_id AND d.status::text='draft';
  UPDATE public.expenses d SET exchange_rate=s.rate, base_amount=round(coalesce(d.amount,0)*s.rate,2) FROM LATERAL public.fx_stamp_document(d.organization_id,d.business_id,d.currency,d.expense_date) s WHERE d.business_id=p_business_id AND d.status::text='draft';

  v_drafts := v_readiness->'draft_counts';
  INSERT INTO public.business_currency_change_audit (
    organization_id,business_id,actor_id,old_currency,new_currency,reason,draft_counts,impact_snapshot
  ) VALUES (
    v_business.organization_id,p_business_id,auth.uid(),upper(v_business.base_currency),v_new_currency,v_reason,v_drafts,v_readiness
  );

  INSERT INTO public.audit_logs (
    organization_id,business_id,user_id,action,entity_type,entity_id,entity_name,new_values,changes_summary
  ) VALUES (
    v_business.organization_id,p_business_id,auth.uid(),'business.base_currency.changed','business',p_business_id,v_business.name,
    jsonb_build_object('old_currency',upper(v_business.base_currency),'new_currency',v_new_currency,'draft_counts',v_drafts),v_reason
  );

  RETURN jsonb_build_object('old_currency',upper(v_business.base_currency),'new_currency',v_new_currency,'draft_counts',v_drafts);
END;
$$;

REVOKE ALL ON FUNCTION public.change_business_base_currency(uuid,text,text,boolean) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.change_business_base_currency(uuid,text,text,boolean) TO authenticated;

DROP FUNCTION IF EXISTS public.enforce_business_currency_immutable();