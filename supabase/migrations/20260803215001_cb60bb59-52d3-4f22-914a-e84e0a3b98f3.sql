-- ═══════════════════════════════════════════════════════════════════════
-- 3PL billing platform — Phase 1 (executable invoice path)
--                     + Phase 2 (client identity / AR party)
-- ═══════════════════════════════════════════════════════════════════════

-- ── 1) wms_billing_clients — the missing spine ─────────────────────────
CREATE TABLE IF NOT EXISTS public.wms_billing_clients (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id         uuid NOT NULL,
  organization_id     uuid NULL,
  contact_id          uuid NOT NULL REFERENCES public.contacts(id) ON DELETE RESTRICT,
  client_business_id  uuid NULL REFERENCES public.businesses(id) ON DELETE SET NULL,
  code                text NOT NULL,
  name                text NULL,
  currency            text NULL,
  is_active           boolean NOT NULL DEFAULT true,
  notes               text NULL,
  created_by          uuid NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wms_billing_clients_code_unique UNIQUE (business_id, code),
  CONSTRAINT wms_billing_clients_contact_unique UNIQUE (business_id, contact_id)
);

CREATE INDEX IF NOT EXISTS idx_wms_billing_clients_biz
  ON public.wms_billing_clients (business_id, is_active);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.wms_billing_clients TO authenticated;
GRANT ALL ON public.wms_billing_clients TO service_role;

ALTER TABLE public.wms_billing_clients ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "wms_billing_clients_select" ON public.wms_billing_clients;
CREATE POLICY "wms_billing_clients_select" ON public.wms_billing_clients
  FOR SELECT TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id));

DROP POLICY IF EXISTS "wms_billing_clients_write" ON public.wms_billing_clients;
CREATE POLICY "wms_billing_clients_write" ON public.wms_billing_clients
  FOR ALL TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id)
         AND public.user_has_module_permission(auth.uid(), business_id, 'inventory', 'write'))
  WITH CHECK (public.user_can_access_business(auth.uid(), business_id)
              AND public.user_has_module_permission(auth.uid(), business_id, 'inventory', 'write'));

CREATE OR REPLACE FUNCTION public._touch_wms_billing_clients_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS trg_wms_billing_clients_updated_at ON public.wms_billing_clients;
CREATE TRIGGER trg_wms_billing_clients_updated_at
  BEFORE UPDATE ON public.wms_billing_clients
  FOR EACH ROW EXECUTE FUNCTION public._touch_wms_billing_clients_updated_at();

-- ── 2) Repoint tariffs + ledger at the billing client ──────────────────
ALTER TABLE public.wms_billing_tariffs
  ADD COLUMN IF NOT EXISTS client_id uuid NULL
    REFERENCES public.wms_billing_clients(id) ON DELETE CASCADE;

ALTER TABLE public.wms_billable_activities
  ADD COLUMN IF NOT EXISTS client_id uuid NULL
    REFERENCES public.wms_billing_clients(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_wms_billing_tariffs_client_scope
  ON public.wms_billing_tariffs (
    business_id,
    COALESCE(client_id, '00000000-0000-0000-0000-000000000000'::uuid),
    activity, uom, effective_from
  );

CREATE INDEX IF NOT EXISTS idx_wms_billable_activities_client_unbilled
  ON public.wms_billable_activities (business_id, client_id, invoice_id)
  WHERE invoice_id IS NULL;

COMMENT ON COLUMN public.wms_billing_tariffs.client_business_id IS
  'DEPRECATED (Phase 2) — use client_id -> wms_billing_clients. Retained for one release.';
COMMENT ON COLUMN public.wms_billable_activities.client_business_id IS
  'DEPRECATED (Phase 2) — use client_id -> wms_billing_clients. Retained for one release.';

-- ── 3) Activity capture resolves the billing client ────────────────────
CREATE OR REPLACE FUNCTION public.capture_billable_activity(p_event_id uuid)
RETURNS public.wms_billable_activities
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $function$
DECLARE
  v_evt       public.business_event_outbox;
  v_activity  text;
  v_biz       uuid;
  v_client    uuid;
  v_client_bz uuid;
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

  -- Client resolution: explicit billing client id first, then a legacy
  -- client_business_id payload key mapped through wms_billing_clients.
  v_client    := NULLIF(v_evt.payload->>'client_id','')::uuid;
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

  -- Tariff: client-specific first, then the business default (client_id NULL).
  SELECT * INTO v_tariff
    FROM public.wms_billing_tariffs t
   WHERE t.business_id = v_biz
     AND t.activity    = v_activity
     AND t.is_active
     AND t.effective_from <= v_occurred::date
     AND (t.effective_to IS NULL OR t.effective_to >= v_occurred::date)
     AND (t.client_id IS NULL OR t.client_id = v_client)
   ORDER BY (t.client_id IS NOT NULL) DESC, t.effective_from DESC
   LIMIT 1;

  INSERT INTO public.wms_billable_activities (
    business_id, client_id, client_business_id, warehouse_id, activity, uom,
    quantity, occurred_at, source_event_id, source_doc_type, source_doc_id,
    tariff_id, unit_rate, currency, amount
  ) VALUES (
    v_biz, v_client, v_client_bz, v_warehouse, v_activity,
    COALESCE(v_tariff.uom, 'unit'),
    v_qty, v_occurred, p_event_id, v_evt.source_doc_type, v_evt.source_doc_id,
    v_tariff.id, v_tariff.rate, v_tariff.currency,
    CASE WHEN v_tariff.id IS NOT NULL THEN round(v_qty * v_tariff.rate, 4) ELSE NULL END
  ) RETURNING * INTO v_row;

  RETURN v_row;
END; $function$;

REVOKE ALL ON FUNCTION public.capture_billable_activity(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.capture_billable_activity(uuid) TO authenticated, service_role;

-- ── 4) Storage accrual keeps pricing off the default tariff (client_id NULL)
CREATE OR REPLACE FUNCTION public.wms_accrue_storage_days(
  p_business_id uuid,
  p_as_of date DEFAULT CURRENT_DATE
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $function$
DECLARE
  v_rec      record;
  v_tariff   public.wms_billing_tariffs;
  v_occurred timestamptz;
  v_count    int := 0;
BEGIN
  IF NOT public.user_can_access_business(auth.uid(), p_business_id) THEN
    RAISE EXCEPTION 'access denied';
  END IF;
  IF NOT public.user_has_module_permission(auth.uid(), p_business_id, 'inventory', 'write') THEN
    RAISE EXCEPTION 'access denied';
  END IF;
  IF p_as_of IS NULL OR p_as_of > CURRENT_DATE THEN
    RAISE EXCEPTION 'cannot accrue storage for a future date';
  END IF;

  v_occurred := (p_as_of + 1)::timestamptz - interval '1 second';

  FOR v_rec IN
    SELECT lp.warehouse_id, count(*)::numeric AS qty
      FROM public.wms_license_plates lp
     WHERE lp.business_id = p_business_id
       AND lp.status IN ('stored', 'quarantined')
       AND lp.created_at <= v_occurred
     GROUP BY lp.warehouse_id
  LOOP
    SELECT * INTO v_tariff
      FROM public.wms_billing_tariffs t
     WHERE t.business_id = p_business_id
       AND t.activity = 'storage_lpn_day'
       AND t.is_active
       AND t.effective_from <= p_as_of
       AND (t.effective_to IS NULL OR t.effective_to >= p_as_of)
       AND t.client_id IS NULL
     ORDER BY t.effective_from DESC
     LIMIT 1;

    INSERT INTO public.wms_billable_activities (
      business_id, client_id, client_business_id, warehouse_id, activity, uom,
      quantity, occurred_at, source_event_id, source_doc_type, source_doc_id,
      tariff_id, unit_rate, currency, amount
    ) VALUES (
      p_business_id, NULL, NULL, v_rec.warehouse_id, 'storage_lpn_day',
      COALESCE(v_tariff.uom, 'lpn_day'),
      v_rec.qty, v_occurred, NULL, 'wms_storage_accrual', v_rec.warehouse_id,
      v_tariff.id, v_tariff.rate, v_tariff.currency,
      CASE WHEN v_tariff.id IS NOT NULL THEN round(v_rec.qty * v_tariff.rate, 4) ELSE NULL END
    )
    ON CONFLICT DO NOTHING;

    IF FOUND THEN v_count := v_count + 1; END IF;
  END LOOP;

  RETURN v_count;
END; $function$;

REVOKE ALL ON FUNCTION public.wms_accrue_storage_days(uuid, date) FROM public;
GRANT EXECUTE ON FUNCTION public.wms_accrue_storage_days(uuid, date) TO authenticated, service_role;

-- ── 5) generate_3pl_invoice — rewritten so it can execute ──────────────
DROP FUNCTION IF EXISTS public.generate_3pl_invoice(uuid, uuid, date, date, uuid, text);

CREATE OR REPLACE FUNCTION public.generate_3pl_invoice(
  p_business_id uuid,
  p_client_id   uuid,
  p_period_from date,
  p_period_to   date,
  p_branch_id   uuid DEFAULT NULL,
  p_currency    text DEFAULT NULL
) RETURNS public.invoices
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $function$
DECLARE
  v_biz        public.businesses;
  v_client     public.wms_billing_clients;
  v_invoice    public.invoices;
  v_number     text;
  v_branch     uuid;
  v_currency   text;
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

  SELECT * INTO v_biz FROM public.businesses WHERE id = p_business_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'business not found'; END IF;

  SELECT * INTO v_client
    FROM public.wms_billing_clients
   WHERE id = p_client_id AND business_id = p_business_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'billing client not found for this business'; END IF;
  IF v_client.contact_id IS NULL THEN
    RAISE EXCEPTION 'billing client % has no AR contact', v_client.code;
  END IF;

  -- Branch: explicit > business HQ. invoices.branch_id feeds numbering.
  v_branch := COALESCE(
    p_branch_id,
    (SELECT id FROM public.branches
      WHERE business_id = p_business_id AND is_active
      ORDER BY is_headquarters DESC, created_at
      LIMIT 1)
  );

  v_currency := COALESCE(p_currency, v_client.currency, v_biz.base_currency, 'USD');

  -- Mixed currency inside one period is an error, never a silent drop.
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

  -- Tax from the AR contact's default rate (canonical invoice tax path).
  SELECT COALESCE(tr.rate, 0) INTO v_tax_rate
    FROM public.contacts c
    LEFT JOIN public.tax_rates tr ON tr.id = c.default_tax_rate_id
   WHERE c.id = v_client.contact_id;
  v_tax_rate := COALESCE(v_tax_rate, 0);

  v_number := public.generate_invoice_number(v_biz.organization_id, p_business_id, v_branch);

  INSERT INTO public.invoices (
    organization_id, business_id, branch_id, contact_id, invoice_number,
    status, issue_date, due_date, subtotal, tax_amount, total, currency, notes, source
  ) VALUES (
    v_biz.organization_id, p_business_id, v_branch, v_client.contact_id, v_number,
    'draft', CURRENT_DATE, CURRENT_DATE + 30, 0, 0, 0, v_currency,
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

REVOKE ALL ON FUNCTION public.generate_3pl_invoice(uuid, uuid, date, date, uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.generate_3pl_invoice(uuid, uuid, date, date, uuid, text) TO authenticated, service_role;

-- ── 6) Summary view carries the billing client ─────────────────────────
DROP VIEW IF EXISTS public.wms_billable_activities_summary_view;
CREATE VIEW public.wms_billable_activities_summary_view
WITH (security_invoker = true) AS
SELECT
  ba.business_id,
  ba.client_id,
  ba.client_business_id,
  ba.activity,
  ba.uom,
  ba.currency,
  count(*)                                                  AS entry_count,
  sum(ba.quantity)                                          AS total_quantity,
  sum(COALESCE(ba.amount, 0))                               AS total_amount,
  sum(CASE WHEN ba.invoice_id IS NULL THEN COALESCE(ba.amount, 0) ELSE 0 END) AS unbilled_amount,
  count(*) FILTER (WHERE ba.tariff_id IS NULL)              AS unpriced_count,
  max(ba.occurred_at)                                       AS last_occurred_at
FROM public.wms_billable_activities ba
GROUP BY ba.business_id, ba.client_id, ba.client_business_id,
         ba.activity, ba.uom, ba.currency;

GRANT SELECT ON public.wms_billable_activities_summary_view TO authenticated, service_role;