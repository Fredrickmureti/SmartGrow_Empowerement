-- =====================================================================
-- WMS Phase 5.4 — storage-day accrual for 3PL billing
-- `storage_lpn_day` is offered as a tariff activity in BillingBoard but
-- had no producer: storage is time-based, so it cannot come off the
-- event outbox. This adds an idempotent daily accrual.
-- =====================================================================

-- Idempotency for accrual rows (source_event_id is NULL for these, so the
-- existing UNIQUE (business_id, source_event_id) does not cover them).
CREATE UNIQUE INDEX IF NOT EXISTS uq_wms_billable_storage_day
  ON public.wms_billable_activities (
    business_id,
    activity,
    COALESCE(warehouse_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(client_business_id, '00000000-0000-0000-0000-000000000000'::uuid),
    ((occurred_at AT TIME ZONE 'UTC')::date)
  )
  WHERE source_event_id IS NULL AND activity = 'storage_lpn_day';

CREATE OR REPLACE FUNCTION public.wms_accrue_storage_days(
  p_business_id uuid,
  p_as_of       date DEFAULT CURRENT_DATE
) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_rec      record;
  v_tariff   public.wms_billing_tariffs;
  v_occurred timestamptz;
  v_count    int := 0;
BEGIN
  IF p_business_id NOT IN (
    SELECT business_id FROM public.user_business_access WHERE user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'access denied';
  END IF;

  IF NOT public.user_has_module_permission(auth.uid(), p_business_id, 'inventory', 'write') THEN
    RAISE EXCEPTION 'access denied';
  END IF;

  IF p_as_of IS NULL OR p_as_of > CURRENT_DATE THEN
    RAISE EXCEPTION 'cannot accrue storage for a future date';
  END IF;

  -- Occupancy snapshot at end of the accrual day: plates that exist by
  -- then and are still holding a storage location.
  v_occurred := (p_as_of + 1)::timestamptz - interval '1 second';

  FOR v_rec IN
    SELECT lp.warehouse_id, count(*)::numeric AS qty
      FROM public.wms_license_plates lp
     WHERE lp.business_id = p_business_id
       AND lp.status IN ('stored', 'quarantined')
       AND lp.created_at <= v_occurred
     GROUP BY lp.warehouse_id
  LOOP
    -- Tariff resolution mirrors capture_billable_activity: org-default
    -- (no client) tariff, since a license plate carries no 3PL client.
    SELECT * INTO v_tariff
      FROM public.wms_billing_tariffs t
     WHERE t.business_id = p_business_id
       AND t.activity = 'storage_lpn_day'
       AND t.is_active
       AND t.effective_from <= p_as_of
       AND (t.effective_to IS NULL OR t.effective_to >= p_as_of)
       AND t.client_business_id IS NULL
     ORDER BY t.effective_from DESC
     LIMIT 1;

    INSERT INTO public.wms_billable_activities (
      business_id, client_business_id, warehouse_id, activity, uom,
      quantity, occurred_at, source_event_id, source_doc_type, source_doc_id,
      tariff_id, unit_rate, currency, amount
    ) VALUES (
      p_business_id, NULL, v_rec.warehouse_id, 'storage_lpn_day',
      COALESCE(v_tariff.uom, 'lpn_day'),
      v_rec.qty, v_occurred, NULL, 'wms_storage_accrual', v_rec.warehouse_id,
      v_tariff.id, v_tariff.rate, v_tariff.currency,
      CASE WHEN v_tariff.id IS NOT NULL THEN round(v_rec.qty * v_tariff.rate, 4) ELSE NULL END
    )
    ON CONFLICT DO NOTHING;

    IF FOUND THEN v_count := v_count + 1; END IF;
  END LOOP;

  RETURN v_count;
END; $$;

REVOKE ALL ON FUNCTION public.wms_accrue_storage_days(uuid, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_accrue_storage_days(uuid, date) TO authenticated, service_role;

COMMENT ON FUNCTION public.wms_accrue_storage_days(uuid, date) IS
  'WMS 5.4 — idempotent daily storage accrual. One storage_lpn_day billable row per (business, warehouse, day) counting occupying license plates.';