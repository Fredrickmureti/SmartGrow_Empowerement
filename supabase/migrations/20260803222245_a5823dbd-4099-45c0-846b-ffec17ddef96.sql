-- ═══════════════════════════════════════════════════════════════════
-- 3PL billing — Phase 5b: internal capture engine, period + FX rules
-- ═══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public._wms_capture_billable_activity_internal(p_event_id uuid)
RETURNS public.wms_billable_activities
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $function$
DECLARE
  v_evt       public.business_event_outbox;
  v_activity  text;
  v_biz       uuid;
  v_org       uuid;
  v_client    uuid;
  v_client_bz uuid;
  v_warehouse uuid;
  v_qty       numeric;
  v_occurred  timestamptz;
  v_tariff    public.wms_billing_tariffs;
  v_existing  public.wms_billable_activities;
  v_row       public.wms_billable_activities;
  v_amount    numeric;
  v_code      text;
BEGIN
  SELECT * INTO v_evt FROM public.business_event_outbox WHERE id = p_event_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'event not found'; END IF;

  v_biz := v_evt.org_id;

  v_activity := public._wms_map_event_to_activity(v_evt.event_type, v_evt.payload);
  IF v_activity IS NULL THEN
    RAISE EXCEPTION 'event_type % is not billable', v_evt.event_type;
  END IF;

  SELECT * INTO v_existing
    FROM public.wms_billable_activities
   WHERE business_id = v_biz AND source_event_id = p_event_id;
  IF FOUND THEN RETURN v_existing; END IF;

  v_occurred := COALESCE(v_evt.created_at, now());
  PERFORM public._wms_assert_period_open(v_biz, v_occurred::date);

  v_client    := public._wms_resolve_client_id(v_biz, v_evt.payload,
                   NULLIF(v_evt.payload->>'aggregate_id','')::uuid);
  v_client_bz := NULLIF(v_evt.payload->>'client_business_id','')::uuid;

  IF v_client IS NOT NULL THEN
    SELECT id INTO v_client FROM public.wms_billing_clients
     WHERE business_id = v_biz AND id = v_client AND is_active;
  ELSIF v_client_bz IS NOT NULL THEN
    SELECT id INTO v_client FROM public.wms_billing_clients
     WHERE business_id = v_biz AND client_business_id = v_client_bz AND is_active
     LIMIT 1;
  END IF;

  v_warehouse := COALESCE(v_evt.warehouse_id,
                          NULLIF(v_evt.payload->>'warehouse_id','')::uuid);
  v_qty       := COALESCE((v_evt.payload->>'quantity')::numeric,
                          (v_evt.payload->>'dwell_minutes')::numeric / 60.0,
                          1);

  v_tariff := public._wms_resolve_tariff(v_biz, v_client, v_activity,
                                         v_occurred::date, v_qty);
  v_amount := public._wms_price_activity(v_tariff, v_qty);

  INSERT INTO public.wms_billable_activities (
    business_id, client_id, client_business_id, warehouse_id, activity, uom,
    quantity, occurred_at, source_event_id, source_doc_type, source_doc_id,
    tariff_id, unit_rate, currency, amount
  ) VALUES (
    v_biz, v_client, v_client_bz, v_warehouse, v_activity,
    COALESCE(v_tariff.uom, 'unit'),
    v_qty, v_occurred, p_event_id, v_evt.source_doc_type, v_evt.source_doc_id,
    v_tariff.id, v_tariff.rate, v_tariff.currency, v_amount
  ) RETURNING * INTO v_row;

  IF v_tariff.id IS NULL AND v_warehouse IS NOT NULL THEN
    SELECT organization_id INTO v_org FROM public.businesses WHERE id = v_biz;
    SELECT code INTO v_code FROM public.wms_billing_clients WHERE id = v_client;

    IF NOT EXISTS (
      SELECT 1 FROM public.wms_exceptions
       WHERE business_id = v_biz
         AND kind = 'billing_unpriced'
         AND state IN ('open','acknowledged','investigating','escalated')
         AND aggregate_type = 'wms_billable_activities'
         AND details->>'activity' = v_activity
         AND COALESCE(details->>'client_id','') = COALESCE(v_client::text,'')
    ) THEN
      INSERT INTO public.wms_exceptions (
        organization_id, business_id, branch_id, warehouse_id, kind, state,
        severity, aggregate_type, aggregate_id, reason, details, raised_by
      ) VALUES (
        v_org, v_biz, v_evt.branch_id, v_warehouse, 'billing_unpriced', 'open',
        2, 'wms_billable_activities', v_row.id,
        'No active tariff prices "' || v_activity || '"'
          || COALESCE(' for client ' || v_code, ' (no client attributed)')
          || ' — this work cannot be invoiced.',
        jsonb_build_object('activity', v_activity, 'client_id', v_client,
                           'quantity', v_qty, 'occurred_at', v_occurred),
        auth.uid()
      );
    END IF;
  END IF;

  RETURN v_row;
END; $function$;

REVOKE ALL ON FUNCTION public._wms_capture_billable_activity_internal(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public._wms_capture_billable_activity_internal(uuid)
  TO authenticated, service_role;

-- Human-facing entry point keeps the permission gate.
CREATE OR REPLACE FUNCTION public.capture_billable_activity(p_event_id uuid)
RETURNS public.wms_billable_activities
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $function$
DECLARE
  v_biz uuid;
BEGIN
  SELECT org_id INTO v_biz FROM public.business_event_outbox WHERE id = p_event_id;
  IF v_biz IS NULL THEN RAISE EXCEPTION 'event not found'; END IF;
  IF NOT public.user_can_access_business(auth.uid(), v_biz) THEN
    RAISE EXCEPTION 'access denied';
  END IF;
  RETURN public._wms_capture_billable_activity_internal(p_event_id);
END; $function$;

-- ── Invoice generation: period discipline + FX stamp ────────────────
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
       AND occurred_at::date BETWEEN p_period_from AND p_period_to
       AND currency IS NOT NULL
       AND currency <> v_currency
  ) THEN
    RAISE EXCEPTION 'period contains activity in more than one currency; bill each currency separately';
  END IF;

  -- FX: canonical exchange_rates, latest on/before issue date.
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
