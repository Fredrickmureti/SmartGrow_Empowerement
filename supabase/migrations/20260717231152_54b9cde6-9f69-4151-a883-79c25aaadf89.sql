
-- =====================================================================
-- WMS Phase 11 — 3PL activity-based billing
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) wms_billing_tariffs — master data (biz-scoped, PostgREST writes ok)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.wms_billing_tariffs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id         uuid NOT NULL,
  client_business_id  uuid NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  activity            text NOT NULL,
  uom                 text NOT NULL DEFAULT 'unit',
  rate                numeric(15,4) NOT NULL CHECK (rate >= 0),
  currency            text NOT NULL DEFAULT 'USD',
  effective_from      date NOT NULL DEFAULT CURRENT_DATE,
  effective_to        date NULL,
  is_active           boolean NOT NULL DEFAULT true,
  notes               text,
  created_by          uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wms_billing_tariffs_unique
    UNIQUE (business_id, client_business_id, activity, uom, effective_from),
  CONSTRAINT wms_billing_tariffs_effective_range
    CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE INDEX IF NOT EXISTS idx_wms_billing_tariffs_lookup
  ON public.wms_billing_tariffs (business_id, activity, is_active, effective_from);
CREATE INDEX IF NOT EXISTS idx_wms_billing_tariffs_client
  ON public.wms_billing_tariffs (client_business_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.wms_billing_tariffs TO authenticated;
GRANT ALL ON public.wms_billing_tariffs TO service_role;

ALTER TABLE public.wms_billing_tariffs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "wms_billing_tariffs_select" ON public.wms_billing_tariffs
  FOR SELECT TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id));

CREATE POLICY "wms_billing_tariffs_write" ON public.wms_billing_tariffs
  FOR ALL TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id)
         AND public.user_has_module_permission(auth.uid(), business_id, 'inventory', 'write'))
  WITH CHECK (public.user_can_access_business(auth.uid(), business_id)
              AND public.user_has_module_permission(auth.uid(), business_id, 'inventory', 'write'));

CREATE OR REPLACE FUNCTION public._touch_wms_billing_tariffs_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS trg_wms_billing_tariffs_updated_at ON public.wms_billing_tariffs;
CREATE TRIGGER trg_wms_billing_tariffs_updated_at
  BEFORE UPDATE ON public.wms_billing_tariffs
  FOR EACH ROW EXECUTE FUNCTION public._touch_wms_billing_tariffs_updated_at();

-- ---------------------------------------------------------------------
-- 2) wms_billable_activities — RPC-only ledger
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.wms_billable_activities (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id         uuid NOT NULL,
  client_business_id  uuid NULL REFERENCES public.businesses(id) ON DELETE SET NULL,
  warehouse_id        uuid NULL,
  activity            text NOT NULL,
  uom                 text NOT NULL DEFAULT 'unit',
  quantity            numeric NOT NULL DEFAULT 1,
  occurred_at         timestamptz NOT NULL DEFAULT now(),
  source_event_id     uuid NULL REFERENCES public.business_event_outbox(id) ON DELETE SET NULL,
  source_doc_type     text NULL,
  source_doc_id       uuid NULL,
  tariff_id           uuid NULL REFERENCES public.wms_billing_tariffs(id) ON DELETE SET NULL,
  unit_rate           numeric(15,4) NULL,
  currency            text NULL,
  amount              numeric(15,4) NULL,
  invoice_id          uuid NULL REFERENCES public.invoices(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, source_event_id)
);

CREATE INDEX IF NOT EXISTS idx_wms_billable_activities_biz
  ON public.wms_billable_activities (business_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_wms_billable_activities_unbilled
  ON public.wms_billable_activities (business_id, client_business_id, invoice_id)
  WHERE invoice_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_wms_billable_activities_invoice
  ON public.wms_billable_activities (invoice_id);

GRANT SELECT ON public.wms_billable_activities TO authenticated;
GRANT ALL  ON public.wms_billable_activities TO service_role;

ALTER TABLE public.wms_billable_activities ENABLE ROW LEVEL SECURITY;

CREATE POLICY "wms_billable_activities_select" ON public.wms_billable_activities
  FOR SELECT TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id));

-- No INSERT/UPDATE/DELETE policies — writes only through SECURITY DEFINER RPCs.

-- ---------------------------------------------------------------------
-- 3) Event → activity mapping helper
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._wms_map_event_to_activity(p_event_type text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_event_type
    WHEN 'warehouse.grn.received'          THEN 'receive_lpn'
    WHEN 'warehouse.putaway.completed'     THEN 'putaway'
    WHEN 'warehouse.pick.completed'        THEN 'pick_line'
    WHEN 'warehouse.pack.completed'        THEN 'pack_package'
    WHEN 'warehouse.shipment.dispatched'   THEN 'dispatch_shipment'
    WHEN 'warehouse.yard.departed'         THEN 'yard_dwell'
    WHEN 'warehouse.qc.rejected'           THEN 'qc_inspection'
    WHEN 'warehouse.qc.accepted'           THEN 'qc_inspection'
    WHEN 'warehouse.cycle_count.variance'  THEN 'cycle_count'
    ELSE NULL
  END;
$$;

-- ---------------------------------------------------------------------
-- 4) RPC: capture_billable_activity (single event, idempotent)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.capture_billable_activity(p_event_id uuid)
RETURNS public.wms_billable_activities
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_evt       public.business_event_outbox;
  v_activity  text;
  v_biz       uuid;
  v_client    uuid;
  v_warehouse uuid;
  v_qty       numeric;
  v_occurred  timestamptz;
  v_tariff    public.wms_billing_tariffs;
  v_existing  public.wms_billable_activities;
  v_row       public.wms_billable_activities;
BEGIN
  SELECT * INTO v_evt FROM public.business_event_outbox WHERE id = p_event_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'event not found'; END IF;

  -- org_id on the outbox holds the business_id in this codebase.
  v_biz := v_evt.org_id;

  IF v_biz NOT IN (SELECT business_id FROM public.user_business_access WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'access denied';
  END IF;

  v_activity := public._wms_map_event_to_activity(v_evt.event_type);
  IF v_activity IS NULL THEN
    RAISE EXCEPTION 'event_type % is not billable', v_evt.event_type;
  END IF;

  -- Idempotency: return the prior row if this event was already captured.
  SELECT * INTO v_existing
    FROM public.wms_billable_activities
   WHERE business_id = v_biz AND source_event_id = p_event_id;
  IF FOUND THEN RETURN v_existing; END IF;

  v_client    := NULLIF(v_evt.payload->>'client_business_id','')::uuid;
  v_warehouse := COALESCE(v_evt.warehouse_id,
                          NULLIF(v_evt.payload->>'warehouse_id','')::uuid);
  v_qty       := COALESCE((v_evt.payload->>'quantity')::numeric,
                          (v_evt.payload->>'dwell_minutes')::numeric / 60.0,
                          1);
  v_occurred  := COALESCE(v_evt.created_at, now());

  -- Resolve tariff: prefer client-specific + within-effective-range,
  -- fall back to org-default (client_business_id IS NULL).
  SELECT * INTO v_tariff
    FROM public.wms_billing_tariffs t
   WHERE t.business_id = v_biz
     AND t.activity    = v_activity
     AND t.is_active
     AND (t.effective_from <= v_occurred::date)
     AND (t.effective_to IS NULL OR t.effective_to >= v_occurred::date)
     AND (t.client_business_id = v_client OR t.client_business_id IS NULL)
   ORDER BY (t.client_business_id IS NOT NULL) DESC, t.effective_from DESC
   LIMIT 1;

  INSERT INTO public.wms_billable_activities (
    business_id, client_business_id, warehouse_id, activity, uom,
    quantity, occurred_at, source_event_id, source_doc_type, source_doc_id,
    tariff_id, unit_rate, currency, amount
  ) VALUES (
    v_biz, v_client, v_warehouse, v_activity,
    COALESCE(v_tariff.uom, 'unit'),
    v_qty, v_occurred, p_event_id, v_evt.source_doc_type, v_evt.source_doc_id,
    v_tariff.id, v_tariff.rate, v_tariff.currency,
    CASE WHEN v_tariff.id IS NOT NULL THEN round(v_qty * v_tariff.rate, 4) ELSE NULL END
  ) RETURNING * INTO v_row;

  RETURN v_row;
END; $$;

REVOKE ALL ON FUNCTION public.capture_billable_activity(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.capture_billable_activity(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------
-- 5) RPC: capture_pending_billable_activities (drain)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.capture_pending_billable_activities(
  p_business_id uuid,
  p_limit int DEFAULT 200
) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_evt_id uuid;
  v_count  int := 0;
BEGIN
  IF p_business_id NOT IN (SELECT business_id FROM public.user_business_access WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'access denied';
  END IF;

  FOR v_evt_id IN
    SELECT o.id
      FROM public.business_event_outbox o
      LEFT JOIN public.wms_billable_activities b
        ON b.source_event_id = o.id AND b.business_id = o.org_id
     WHERE o.org_id = p_business_id
       AND o.event_type LIKE 'warehouse.%'
       AND public._wms_map_event_to_activity(o.event_type) IS NOT NULL
       AND b.id IS NULL
     ORDER BY o.created_at ASC
     LIMIT p_limit
  LOOP
    BEGIN
      PERFORM public.capture_billable_activity(v_evt_id);
      v_count := v_count + 1;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'capture failed for event %: %', v_evt_id, SQLERRM;
    END;
  END LOOP;

  RETURN v_count;
END; $$;

REVOKE ALL ON FUNCTION public.capture_pending_billable_activities(uuid,int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.capture_pending_billable_activities(uuid,int) TO authenticated, service_role;

-- ---------------------------------------------------------------------
-- 6) RPC: generate_3pl_invoice
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.generate_3pl_invoice(
  p_business_id        uuid,
  p_client_business_id uuid,
  p_period_from        date,
  p_period_to          date,
  p_contact_id         uuid DEFAULT NULL,
  p_currency           text DEFAULT NULL
) RETURNS public.invoices
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_biz         public.businesses;
  v_invoice     public.invoices;
  v_number      text;
  v_subtotal    numeric(15,2) := 0;
  v_currency    text;
  v_line        record;
  v_priced_cnt  int := 0;
BEGIN
  IF p_business_id NOT IN (SELECT business_id FROM public.user_business_access WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'access denied';
  END IF;
  IF p_period_from IS NULL OR p_period_to IS NULL OR p_period_to < p_period_from THEN
    RAISE EXCEPTION 'invalid period';
  END IF;

  SELECT * INTO v_biz FROM public.businesses WHERE id = p_business_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'business not found'; END IF;

  -- Pick a currency: explicit param > first priced activity > business base > USD.
  SELECT COALESCE(p_currency,
                  (SELECT currency FROM public.wms_billable_activities
                    WHERE business_id = p_business_id
                      AND client_business_id = p_client_business_id
                      AND invoice_id IS NULL
                      AND occurred_at::date BETWEEN p_period_from AND p_period_to
                      AND currency IS NOT NULL
                    LIMIT 1),
                  v_biz.base_currency,
                  'USD')
    INTO v_currency;

  v_number := '3PL-' || to_char(p_period_from,'YYYYMM') || '-'
              || substr(replace(p_client_business_id::text,'-',''),1,6);

  -- Create the draft invoice shell.
  INSERT INTO public.invoices (
    organization_id, contact_id, invoice_number, status,
    issue_date, due_date, subtotal, total, currency, notes
  ) VALUES (
    v_biz.organization_id, p_contact_id, v_number, 'draft',
    CURRENT_DATE, CURRENT_DATE + 30, 0, 0, v_currency,
    '3PL activity billing ' || p_period_from || ' → ' || p_period_to
  ) RETURNING * INTO v_invoice;

  -- One line per (activity, uom, unit_rate).
  FOR v_line IN
    SELECT activity, uom, unit_rate,
           SUM(quantity)                                              AS qty,
           SUM(COALESCE(amount, 0))                                   AS amt,
           array_agg(id)                                              AS ids
      FROM public.wms_billable_activities
     WHERE business_id = p_business_id
       AND client_business_id = p_client_business_id
       AND invoice_id IS NULL
       AND tariff_id IS NOT NULL
       AND occurred_at::date BETWEEN p_period_from AND p_period_to
       AND COALESCE(currency, v_currency) = v_currency
     GROUP BY activity, uom, unit_rate
  LOOP
    INSERT INTO public.invoice_items (
      invoice_id, description, quantity, unit_price, subtotal, total
    ) VALUES (
      v_invoice.id,
      v_line.activity || ' (' || v_line.uom || ')',
      v_line.qty, v_line.unit_rate,
      round(v_line.amt, 2), round(v_line.amt, 2)
    );

    UPDATE public.wms_billable_activities
       SET invoice_id = v_invoice.id
     WHERE id = ANY (v_line.ids);

    v_subtotal   := v_subtotal + round(v_line.amt, 2);
    v_priced_cnt := v_priced_cnt + 1;
  END LOOP;

  IF v_priced_cnt = 0 THEN
    -- Nothing to bill — drop the empty shell so we don't clutter Sales.
    DELETE FROM public.invoices WHERE id = v_invoice.id;
    RAISE EXCEPTION 'no billable activity in period';
  END IF;

  UPDATE public.invoices
     SET subtotal = v_subtotal, total = v_subtotal
   WHERE id = v_invoice.id
   RETURNING * INTO v_invoice;

  RETURN v_invoice;
END; $$;

REVOKE ALL ON FUNCTION public.generate_3pl_invoice(uuid,uuid,date,date,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.generate_3pl_invoice(uuid,uuid,date,date,uuid,text) TO authenticated, service_role;

-- ---------------------------------------------------------------------
-- 7) Summary view for the UI
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW public.wms_billable_activities_summary_view
WITH (security_invoker = true) AS
SELECT
  ba.business_id,
  ba.client_business_id,
  ba.activity,
  ba.uom,
  ba.currency,
  COUNT(*)                                    AS entry_count,
  SUM(ba.quantity)                            AS total_quantity,
  SUM(COALESCE(ba.amount, 0))                 AS total_amount,
  SUM(CASE WHEN ba.invoice_id IS NULL
           THEN COALESCE(ba.amount, 0) ELSE 0 END) AS unbilled_amount,
  MIN(ba.occurred_at)                         AS first_occurred_at,
  MAX(ba.occurred_at)                         AS last_occurred_at
FROM public.wms_billable_activities ba
GROUP BY ba.business_id, ba.client_business_id, ba.activity, ba.uom, ba.currency;

GRANT SELECT ON public.wms_billable_activities_summary_view TO authenticated, service_role;
