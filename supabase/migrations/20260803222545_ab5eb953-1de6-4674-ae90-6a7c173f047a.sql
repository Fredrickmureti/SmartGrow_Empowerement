-- Disputed activity never lands on an invoice until it is resolved.
CREATE OR REPLACE FUNCTION public.generate_3pl_invoice(
  p_business_id uuid, p_client_id uuid, p_period_from date, p_period_to date,
  p_branch_id uuid DEFAULT NULL::uuid, p_currency text DEFAULT NULL::text
) RETURNS public.invoices
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $function$
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
  IF NOT public.user_can_access_business(auth.uid(), p_business_id) THEN
    RAISE EXCEPTION 'access denied';
  END IF;
  IF NOT public.user_has_module_permission(auth.uid(), p_business_id, 'inventory', 'write') THEN
    RAISE EXCEPTION 'access denied';
  END IF;
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

  IF v_currency IS DISTINCT FROM v_biz.base_currency THEN
    SELECT rate INTO v_fx
      FROM public.exchange_rates
     WHERE organization_id = v_biz.organization_id
       AND from_currency = v_currency
       AND to_currency = v_biz.base_currency
       AND effective_date <= CURRENT_DATE
     ORDER BY effective_date DESC
     LIMIT 1;
    IF v_fx IS NULL THEN
      RAISE EXCEPTION 'no exchange rate from % to % on or before %',
        v_currency, v_biz.base_currency, CURRENT_DATE;
    END IF;
  ELSE
    v_fx := 1;
  END IF;

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

-- Summary gains disputed visibility.
DROP VIEW IF EXISTS public.wms_billable_activities_summary_view;
CREATE VIEW public.wms_billable_activities_summary_view
WITH (security_invoker = true) AS
  SELECT business_id, client_id, client_business_id, activity, uom, currency,
         count(*) AS entry_count,
         sum(quantity) AS total_quantity,
         sum(COALESCE(amount, 0::numeric)) AS total_amount,
         sum(CASE WHEN invoice_id IS NULL THEN COALESCE(amount, 0::numeric)
                  ELSE 0::numeric END) AS unbilled_amount,
         count(*) FILTER (WHERE tariff_id IS NULL) AS unpriced_count,
         count(*) FILTER (WHERE disputed_at IS NOT NULL
                            AND dispute_resolved_at IS NULL) AS disputed_count,
         max(occurred_at) AS last_occurred_at
    FROM public.wms_billable_activities ba
   GROUP BY business_id, client_id, client_business_id, activity, uom, currency;

GRANT SELECT ON public.wms_billable_activities_summary_view TO authenticated, service_role;
