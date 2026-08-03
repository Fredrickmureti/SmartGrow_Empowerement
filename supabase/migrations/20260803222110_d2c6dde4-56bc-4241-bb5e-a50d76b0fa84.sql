-- ═══════════════════════════════════════════════════════════════════
-- 3PL billing — Phase 5: finance-grade ledger
-- ═══════════════════════════════════════════════════════════════════

-- ── 1) Ledger immutability ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._wms_billable_activities_immutable()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'wms_billable_activities is an immutable ledger; post a reversing entry instead';
  END IF;

  IF ROW(NEW.*) IS DISTINCT FROM ROW(OLD.*) THEN
    IF (to_jsonb(NEW) - 'invoice_id') IS DISTINCT FROM (to_jsonb(OLD) - 'invoice_id') THEN
      RAISE EXCEPTION
        'wms_billable_activities is an immutable ledger; only invoice_id may be stamped';
    END IF;
  END IF;
  RETURN NEW;
END; $function$;

DROP TRIGGER IF EXISTS tg_wms_billable_activities_immutable ON public.wms_billable_activities;
CREATE TRIGGER tg_wms_billable_activities_immutable
  BEFORE UPDATE OR DELETE ON public.wms_billable_activities
  FOR EACH ROW EXECUTE FUNCTION public._wms_billable_activities_immutable();

-- ── 2) Fiscal period discipline ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public._wms_assert_period_open(
  _business_id uuid, _on_date date
) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $function$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.fiscal_periods
     WHERE business_id = _business_id
       AND _on_date BETWEEN start_date AND end_date
       AND status::text <> 'open'
  ) THEN
    RAISE EXCEPTION 'accounting period covering % is closed', _on_date;
  END IF;
END; $function$;

REVOKE ALL ON FUNCTION public._wms_assert_period_open(uuid, date) FROM public;
GRANT EXECUTE ON FUNCTION public._wms_assert_period_open(uuid, date)
  TO authenticated, service_role;

-- ── 3) Storage accrual idempotency key ──────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS uq_wms_billable_storage_day
  ON public.wms_billable_activities
     (business_id, warehouse_id, COALESCE(client_id, '00000000-0000-0000-0000-000000000000'::uuid),
      activity, occurred_at)
  WHERE source_doc_type = 'wms_storage_accrual';

-- ── 4) Point-in-time, per-client storage accrual ────────────────────
CREATE OR REPLACE FUNCTION public._wms_accrue_storage_days_internal(
  p_business_id uuid, p_as_of date
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $function$
DECLARE
  v_rec      record;
  v_tariff   public.wms_billing_tariffs;
  v_occurred timestamptz;
  v_count    int := 0;
  v_amount   numeric;
BEGIN
  IF p_as_of IS NULL OR p_as_of > CURRENT_DATE THEN
    RAISE EXCEPTION 'cannot accrue storage for a future date';
  END IF;
  PERFORM public._wms_assert_period_open(p_business_id, p_as_of);

  v_occurred := (p_as_of + 1)::timestamptz - interval '1 second';

  FOR v_rec IN
    WITH state_at AS (
      -- Occupancy reconstructed as of the cut-off from LPN history,
      -- falling back to the plate's own status when it has no events.
      SELECT lp.id,
             lp.warehouse_id,
             lp.client_id,
             COALESCE(
               (SELECT e.to_status
                  FROM public.wms_lpn_events e
                 WHERE e.lpn_id = lp.id
                   AND e.created_at <= v_occurred
                   AND e.to_status IS NOT NULL
                 ORDER BY e.created_at DESC
                 LIMIT 1),
               lp.status::text
             ) AS status_at
        FROM public.wms_license_plates lp
       WHERE lp.business_id = p_business_id
         AND lp.created_at <= v_occurred
    )
    SELECT warehouse_id, client_id, count(*)::numeric AS qty
      FROM state_at
     WHERE status_at IN ('stored', 'quarantined')
     GROUP BY warehouse_id, client_id
  LOOP
    v_tariff := public._wms_resolve_tariff(p_business_id, v_rec.client_id,
                                           'storage_lpn_day', p_as_of, v_rec.qty);
    v_amount := public._wms_price_activity(v_tariff, v_rec.qty);

    INSERT INTO public.wms_billable_activities (
      business_id, client_id, client_business_id, warehouse_id, activity, uom,
      quantity, occurred_at, source_event_id, source_doc_type, source_doc_id,
      tariff_id, unit_rate, currency, amount
    ) VALUES (
      p_business_id, v_rec.client_id, NULL, v_rec.warehouse_id, 'storage_lpn_day',
      COALESCE(v_tariff.uom, 'lpn_day'),
      v_rec.qty, v_occurred, NULL, 'wms_storage_accrual', v_rec.warehouse_id,
      v_tariff.id, v_tariff.rate, v_tariff.currency, v_amount
    )
    ON CONFLICT DO NOTHING;

    IF FOUND THEN v_count := v_count + 1; END IF;
  END LOOP;

  RETURN v_count;
END; $function$;

CREATE OR REPLACE FUNCTION public.wms_accrue_storage_days(
  p_business_id uuid, p_as_of date DEFAULT CURRENT_DATE
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $function$
BEGIN
  IF NOT public.user_can_access_business(auth.uid(), p_business_id) THEN
    RAISE EXCEPTION 'access denied';
  END IF;
  IF NOT public.user_has_module_permission(auth.uid(), p_business_id, 'inventory', 'write') THEN
    RAISE EXCEPTION 'access denied';
  END IF;
  RETURN public._wms_accrue_storage_days_internal(p_business_id, p_as_of);
END; $function$;

-- ── 5) Nightly sweep across every 3PL business ──────────────────────
CREATE OR REPLACE FUNCTION public.wms_billing_nightly_sweep()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $function$
DECLARE
  v_biz   uuid;
  v_total int := 0;
  v_evt   record;
BEGIN
  FOR v_biz IN
    SELECT DISTINCT business_id FROM public.wms_billing_clients WHERE is_active
  LOOP
    BEGIN
      v_total := v_total + public._wms_accrue_storage_days_internal(v_biz, CURRENT_DATE - 1);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'storage accrual failed for business %: %', v_biz, SQLERRM;
    END;

    FOR v_evt IN
      SELECT o.id
        FROM public.business_event_outbox o
       WHERE o.org_id = v_biz
         AND o.event_type LIKE 'warehouse.%'
         AND public._wms_map_event_to_activity(o.event_type, o.payload) IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM public.wms_billable_activities a
            WHERE a.business_id = v_biz AND a.source_event_id = o.id)
       ORDER BY o.created_at
       LIMIT 2000
    LOOP
      BEGIN
        PERFORM public._wms_capture_billable_activity_internal(v_evt.id);
        v_total := v_total + 1;
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'capture failed for event %: %', v_evt.id, SQLERRM;
      END;
    END LOOP;
  END LOOP;

  RETURN v_total;
END; $function$;

REVOKE ALL ON FUNCTION public.wms_billing_nightly_sweep() FROM public;
GRANT EXECUTE ON FUNCTION public.wms_billing_nightly_sweep() TO service_role;

SELECT cron.schedule(
  'wms-3pl-billing-nightly-sweep',
  '20 1 * * *',
  $cron$SELECT public.wms_billing_nightly_sweep();$cron$
);
