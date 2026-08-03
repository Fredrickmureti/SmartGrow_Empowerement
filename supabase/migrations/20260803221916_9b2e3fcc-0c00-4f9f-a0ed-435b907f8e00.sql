-- ═══════════════════════════════════════════════════════════════════
-- 3PL billing — Phase 4b: contract-shaped pricing + unpriced exception
-- ═══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public._wms_resolve_tariff(
  _business_id uuid,
  _client_id   uuid,
  _activity    text,
  _on_date     date,
  _quantity    numeric
) RETURNS public.wms_billing_tariffs
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $function$
  SELECT t.*
    FROM public.wms_billing_tariffs t
   WHERE t.business_id = _business_id
     AND t.activity    = _activity
     AND t.is_active
     AND t.effective_from <= _on_date
     AND (t.effective_to IS NULL OR t.effective_to >= _on_date)
     AND (t.client_id IS NULL OR t.client_id = _client_id)
     AND COALESCE(_quantity, 0) >= t.tier_from
     AND (t.tier_to IS NULL OR COALESCE(_quantity, 0) < t.tier_to)
   ORDER BY (t.client_id IS NOT NULL) DESC,
            t.tier_from DESC,
            t.effective_from DESC
   LIMIT 1;
$function$;

REVOKE ALL ON FUNCTION public._wms_resolve_tariff(uuid, uuid, text, date, numeric) FROM public;
GRANT EXECUTE ON FUNCTION public._wms_resolve_tariff(uuid, uuid, text, date, numeric)
  TO authenticated, service_role;

-- Amount for one occurrence: allowance first, then rate, then floor.
CREATE OR REPLACE FUNCTION public._wms_price_activity(
  _tariff public.wms_billing_tariffs,
  _quantity numeric
) RETURNS numeric
LANGUAGE sql IMMUTABLE SET search_path = public AS $function$
  SELECT CASE
    WHEN _tariff.id IS NULL THEN NULL
    ELSE GREATEST(
      round(GREATEST(COALESCE(_quantity, 0) - COALESCE(_tariff.included_quantity, 0), 0)
            * _tariff.rate, 4),
      COALESCE(_tariff.min_charge, 0)
    )
  END;
$function$;

CREATE OR REPLACE FUNCTION public.capture_billable_activity(p_event_id uuid)
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

  IF NOT public.user_can_access_business(auth.uid(), v_biz) THEN
    RAISE EXCEPTION 'access denied';
  END IF;

  v_activity := public._wms_map_event_to_activity(v_evt.event_type, v_evt.payload);
  IF v_activity IS NULL THEN
    RAISE EXCEPTION 'event_type % is not billable', v_evt.event_type;
  END IF;

  SELECT * INTO v_existing
    FROM public.wms_billable_activities
   WHERE business_id = v_biz AND source_event_id = p_event_id;
  IF FOUND THEN RETURN v_existing; END IF;

  -- Client: payload/plate/aggregate chain, then the legacy business link.
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
  v_occurred  := COALESCE(v_evt.created_at, now());

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

  -- Work performed with no price is an operational exception, not silence.
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
