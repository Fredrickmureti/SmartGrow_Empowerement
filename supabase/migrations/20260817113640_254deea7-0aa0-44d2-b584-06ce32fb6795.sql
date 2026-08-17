-- Internal engine: identical logic, no caller-identity gate. Mirrors the
-- _wms_capture_billable_activity_internal / _wms_reprice_billable_activity_internal
-- pattern — the public RPC owns authorisation, the internal owns behaviour.
CREATE OR REPLACE FUNCTION public._wms_generate_3pl_invoice_internal(
  p_business_id uuid,
  p_client_id   uuid,
  p_period_from date,
  p_period_to   date,
  p_branch_id   uuid DEFAULT NULL,
  p_currency    text DEFAULT NULL
)
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
    -- Fully reversed activity groups net to zero: bill nothing, but still claim
    -- the rows so they cannot be picked up by a later run.
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
    -- Draft with no GL footprint: deleting is correct, there is nothing to reverse.
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

REVOKE ALL ON FUNCTION public._wms_generate_3pl_invoice_internal(uuid, uuid, date, date, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._wms_generate_3pl_invoice_internal(uuid, uuid, date, date, uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public._wms_generate_3pl_invoice_internal(uuid, uuid, date, date, uuid, text) TO service_role;

-- Public RPC: authorisation gate only, then delegate.
CREATE OR REPLACE FUNCTION public.generate_3pl_invoice(
  p_business_id uuid,
  p_client_id   uuid,
  p_period_from date,
  p_period_to   date,
  p_branch_id   uuid DEFAULT NULL,
  p_currency    text DEFAULT NULL
)
RETURNS invoices
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.user_can_access_business(auth.uid(), p_business_id) THEN
    RAISE EXCEPTION 'access denied';
  END IF;
  IF NOT public.user_has_module_permission(auth.uid(), p_business_id, 'inventory', 'write') THEN
    RAISE EXCEPTION 'access denied';
  END IF;

  RETURN public._wms_generate_3pl_invoice_internal(
    p_business_id, p_client_id, p_period_from, p_period_to, p_branch_id, p_currency
  );
END; $function$;

-- Generate the corrected 3PL invoice for the simulation period.
SELECT id, invoice_number, subtotal, tax_amount, total, currency, status
FROM public._wms_generate_3pl_invoice_internal(
  'bf392ca6-a743-435c-ae41-5bf25199470d'::uuid,
  '60c9fed0-a72c-46ac-aed3-c2a333ae7add'::uuid,
  '2026-08-01'::date,
  '2026-08-31'::date,
  NULL::uuid,
  'KES'
);