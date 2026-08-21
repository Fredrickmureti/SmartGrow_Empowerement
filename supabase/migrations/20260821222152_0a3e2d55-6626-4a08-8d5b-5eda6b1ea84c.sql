-- ADR 0136 convergence: ONE rate picker. The precedence rules (effective date,
-- business-specific over org-wide, override > manual > provider, published_at)
-- are defined here and nowhere else.
CREATE OR REPLACE FUNCTION public._pick_exchange_rate_row(
  p_org_id uuid,
  p_business_id uuid,
  p_currency text,
  p_base_currency text,
  p_on_date date
)
RETURNS TABLE(rate numeric, source text, provider_key text, effective_date date, scope text)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT er.rate, er.source, er.provider_key, er.effective_date,
         CASE WHEN er.business_id IS NULL THEN 'organization' ELSE 'business' END
    FROM public.exchange_rates er
   WHERE er.organization_id = p_org_id
     AND upper(er.from_currency) = upper(p_currency)
     AND upper(er.to_currency) = upper(p_base_currency)
     AND er.effective_date <= COALESCE(p_on_date, CURRENT_DATE)
     AND (er.business_id IS NULL OR er.business_id = p_business_id)
   ORDER BY
     er.effective_date DESC,
     (er.business_id IS NOT NULL) DESC,
     CASE er.source WHEN 'override' THEN 0 WHEN 'manual' THEN 1 ELSE 2 END,
     er.published_at DESC
   LIMIT 1;
$function$;

REVOKE ALL ON FUNCTION public._pick_exchange_rate_row(uuid, uuid, text, text, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._pick_exchange_rate_row(uuid, uuid, text, text, date) FROM anon;
REVOKE ALL ON FUNCTION public._pick_exchange_rate_row(uuid, uuid, text, text, date) FROM authenticated;

-- The resolver keeps its contract (NULL when nothing is on file, never 1 for an
-- unknown pair) but no longer restates the precedence.
CREATE OR REPLACE FUNCTION public.resolve_exchange_rate(p_org_id uuid, p_business_id uuid, p_currency text, p_on_date date)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_base text;
  v_rate numeric;
BEGIN
  SELECT base_currency INTO v_base FROM public.businesses WHERE id = p_business_id;
  IF p_currency IS NULL OR v_base IS NULL OR upper(p_currency) = upper(v_base) THEN
    RETURN 1;
  END IF;

  SELECT p.rate INTO v_rate
    FROM public._pick_exchange_rate_row(p_org_id, p_business_id, p_currency, v_base, p_on_date) p;

  RETURN v_rate; -- NULL when nothing is on file; callers must never invent one.
END;
$function$;

-- Provenance lookup: same picker, plus the caller-facing access gate.
CREATE OR REPLACE FUNCTION public.describe_exchange_rate(p_org_id uuid, p_business_id uuid, p_currency text, p_on_date date)
 RETURNS TABLE(rate numeric, source text, provider_key text, effective_date date, scope text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_base text;
BEGIN
  IF auth.uid() IS NOT NULL
     AND NOT public.user_can_access_business(auth.uid(), p_business_id) THEN
    RAISE EXCEPTION 'Not authorised for this business' USING ERRCODE = '42501';
  END IF;

  SELECT base_currency INTO v_base FROM public.businesses WHERE id = p_business_id;
  IF p_currency IS NULL OR v_base IS NULL OR upper(p_currency) = upper(v_base) THEN
    RETURN QUERY SELECT 1::numeric, 'base'::text, NULL::text, COALESCE(p_on_date, CURRENT_DATE), 'identity'::text;
    RETURN;
  END IF;

  RETURN QUERY
  SELECT p.rate, p.source, p.provider_key, p.effective_date, p.scope
    FROM public._pick_exchange_rate_row(p_org_id, p_business_id, p_currency, v_base, p_on_date) p;
END;
$function$;

-- 3PL billing: delegate to the strict shared resolver instead of a private
-- lookup that ignored override/manual precedence and business-scoped rows.
CREATE OR REPLACE FUNCTION public._wms_generate_3pl_invoice_internal(p_business_id uuid, p_client_id uuid, p_period_from date, p_period_to date, p_branch_id uuid DEFAULT NULL::uuid, p_currency text DEFAULT NULL::text)
 RETURNS invoices
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_biz        public.businesses;
  v_client     public.wms_billing_clients;
  v_invoice    public.invoices;
  v_number     text;
  v_branch     uuid;
  v_currency   text;
  v_fx         numeric;
  v_tax_rate   numeric := 0;
  v_line       record;
  v_subtotal   numeric(15,2) := 0;
  v_tax_total  numeric(15,2) := 0;
  v_line_tax   numeric(15,2);
  v_priced_cnt int := 0;
  v_sort       int := 0;
BEGIN
  IF p_period_from IS NULL OR p_period_to IS NULL OR p_period_to < p_period_from THEN
    RAISE EXCEPTION 'invalid period';
  END IF;

  PERFORM public._wms_assert_period_open(p_business_id, CURRENT_DATE);

  SELECT * INTO v_biz FROM public.businesses WHERE id = p_business_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'business not found'; END IF;

  SELECT * INTO v_client
    FROM public.wms_billing_clients
   WHERE id = p_client_id AND business_id = p_business_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'billing client not found for this business'; END IF;
  IF v_client.contact_id IS NULL THEN
    RAISE EXCEPTION 'billing client % has no AR contact', v_client.code;
  END IF;

  v_branch := COALESCE(
    p_branch_id,
    (SELECT id FROM public.branches
      WHERE business_id = p_business_id AND is_active
      ORDER BY is_headquarters DESC, created_at
      LIMIT 1)
  );

  v_currency := COALESCE(p_currency, v_client.currency, v_biz.base_currency, 'USD');

  IF EXISTS (
    SELECT 1 FROM public.wms_billable_activities
     WHERE business_id = p_business_id
       AND client_id = p_client_id
       AND invoice_id IS NULL
       AND tariff_id IS NOT NULL
       AND (disputed_at IS NULL OR dispute_resolved_at IS NOT NULL)
       AND occurred_at::date BETWEEN p_period_from AND p_period_to
       AND currency IS NOT NULL
       AND currency <> v_currency
  ) THEN
    RAISE EXCEPTION 'period contains activity in more than one currency; bill each currency separately';
  END IF;

  -- ADR 0136: one resolver. Raises rather than posting an unconverted amount.
  v_fx := public.require_exchange_rate(v_biz.organization_id, p_business_id, v_currency, CURRENT_DATE);

  SELECT COALESCE(tr.rate, 0) INTO v_tax_rate
    FROM public.contacts c
    LEFT JOIN public.tax_rates tr ON tr.id = c.default_tax_rate_id
   WHERE c.id = v_client.contact_id;
  v_tax_rate := COALESCE(v_tax_rate, 0);

  v_number := public.generate_invoice_number(v_biz.organization_id, p_business_id, v_branch);

  INSERT INTO public.invoices (
    organization_id, business_id, branch_id, contact_id, invoice_number,
    status, issue_date, due_date, subtotal, tax_amount, total, currency,
    exchange_rate, notes, source
  ) VALUES (
    v_biz.organization_id, p_business_id, v_branch, v_client.contact_id, v_number,
    'draft', CURRENT_DATE, CURRENT_DATE + 30, 0, 0, 0, v_currency, v_fx,
    '3PL activity billing ' || p_period_from || ' → ' || p_period_to
      || ' (' || v_client.code || ')',
    'wms_3pl_billing'
  ) RETURNING * INTO v_invoice;

  FOR v_line IN
    SELECT activity, uom, unit_rate,
           SUM(quantity)              AS qty,
           SUM(COALESCE(amount, 0))   AS amt,
           array_agg(id)              AS ids
      FROM public.wms_billable_activities
     WHERE business_id = p_business_id
       AND client_id = p_client_id
       AND invoice_id IS NULL
       AND tariff_id IS NOT NULL
       AND (disputed_at IS NULL OR dispute_resolved_at IS NOT NULL)
       AND occurred_at::date BETWEEN p_period_from AND p_period_to
     GROUP BY activity, uom, unit_rate
     ORDER BY activity
  LOOP
    IF round(v_line.amt, 2) = 0 AND COALESCE(v_line.qty, 0) = 0 THEN
      UPDATE public.wms_billable_activities
         SET invoice_id = v_invoice.id
       WHERE id = ANY (v_line.ids);
      CONTINUE;
    END IF;

    v_sort     := v_sort + 1;
    v_line_tax := round(round(v_line.amt, 2) * v_tax_rate / 100.0, 2);

    INSERT INTO public.invoice_items (
      invoice_id, business_id, description, quantity, unit_price,
      tax_rate, tax_amount, line_total, sort_order
    ) VALUES (
      v_invoice.id, p_business_id,
      v_line.activity || ' (' || v_line.uom || ')',
      v_line.qty, v_line.unit_rate,
      v_tax_rate, v_line_tax, round(v_line.amt, 2), v_sort
    );

    UPDATE public.wms_billable_activities
       SET invoice_id = v_invoice.id
     WHERE id = ANY (v_line.ids);

    v_subtotal   := v_subtotal + round(v_line.amt, 2);
    v_tax_total  := v_tax_total + v_line_tax;
    v_priced_cnt := v_priced_cnt + 1;
  END LOOP;

  IF v_priced_cnt = 0 THEN
    UPDATE public.wms_billable_activities SET invoice_id = NULL WHERE invoice_id = v_invoice.id;
    DELETE FROM public.invoices WHERE id = v_invoice.id;
    RAISE EXCEPTION 'no billable activity in period';
  END IF;

  UPDATE public.invoices
     SET subtotal = v_subtotal,
         tax_amount = v_tax_total,
         total = v_subtotal + v_tax_total
   WHERE id = v_invoice.id
   RETURNING * INTO v_invoice;

  RETURN v_invoice;
END; $function$;