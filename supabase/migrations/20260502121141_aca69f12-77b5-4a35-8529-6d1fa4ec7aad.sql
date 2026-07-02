-- Typed, server-validated upsert for notification_alert_settings.
-- Eliminates the class of bug where a frontend form spreads an unvalidated
-- object (potentially containing empty-string timestamps) into PostgREST.

CREATE OR REPLACE FUNCTION public.upsert_notification_alert_settings(
  _organization_id uuid,
  _business_id uuid,
  _settings jsonb
)
RETURNS public.notification_alert_settings
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_row public.notification_alert_settings;
  v_warn int;
  v_crit int;
  v_oos boolean;
  v_inv_days int;
  v_over_days int;
  v_over_esc boolean;
  v_pay_notify boolean;
  v_large numeric;
  v_exp_above numeric;
  v_daily boolean;
  v_weekly boolean;
  v_hour int;
  v_tz varchar;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '42501';
  END IF;

  IF _organization_id IS NULL THEN
    RAISE EXCEPTION 'organization_id required' USING ERRCODE = '22023';
  END IF;

  -- Authorization: caller must belong to the org with admin/owner role.
  -- Falls back to membership check if has_role helper is not present for this org.
  IF NOT EXISTS (
    SELECT 1 FROM public.organization_members om
    WHERE om.organization_id = _organization_id
      AND om.user_id = v_caller
      AND COALESCE(om.role, '') IN ('owner','admin','manager')
  ) THEN
    RAISE EXCEPTION 'forbidden: caller is not an admin of this organization'
      USING ERRCODE = '42501';
  END IF;

  -- Whitelist + coerce + validate
  v_warn      := COALESCE(NULLIF(_settings->>'low_stock_warning_threshold','')::int, 10);
  v_crit      := COALESCE(NULLIF(_settings->>'low_stock_critical_threshold','')::int, 5);
  v_oos       := COALESCE(NULLIF(_settings->>'out_of_stock_alert','')::boolean, true);
  v_inv_days  := COALESCE(NULLIF(_settings->>'invoice_reminder_days_before','')::int, 7);
  v_over_days := COALESCE(NULLIF(_settings->>'overdue_reminder_frequency_days','')::int, 7);
  v_over_esc  := COALESCE(NULLIF(_settings->>'overdue_escalation_enabled','')::boolean, true);
  v_pay_notify:= COALESCE(NULLIF(_settings->>'payment_received_notify','')::boolean, true);
  v_large     := COALESCE(NULLIF(_settings->>'large_payment_threshold','')::numeric, 10000);
  v_exp_above := COALESCE(NULLIF(_settings->>'expense_approval_required_above','')::numeric, 5000);
  v_daily     := COALESCE(NULLIF(_settings->>'daily_digest_enabled','')::boolean, false);
  v_weekly    := COALESCE(NULLIF(_settings->>'weekly_digest_enabled','')::boolean, true);
  v_hour      := COALESCE(NULLIF(_settings->>'digest_send_hour','')::int, 8);
  v_tz        := COALESCE(NULLIF(_settings->>'digest_timezone',''), 'Africa/Nairobi');

  IF v_warn < 0 OR v_warn > 1000000 THEN
    RAISE EXCEPTION 'low_stock_warning_threshold out of range' USING ERRCODE = '22003';
  END IF;
  IF v_crit < 0 OR v_crit > 1000000 THEN
    RAISE EXCEPTION 'low_stock_critical_threshold out of range' USING ERRCODE = '22003';
  END IF;
  IF v_crit > v_warn THEN
    RAISE EXCEPTION 'critical threshold (%) must be <= warning threshold (%)', v_crit, v_warn
      USING ERRCODE = '22023';
  END IF;
  IF v_inv_days < 0 OR v_inv_days > 365 THEN
    RAISE EXCEPTION 'invoice_reminder_days_before out of range' USING ERRCODE = '22003';
  END IF;
  IF v_over_days < 1 OR v_over_days > 365 THEN
    RAISE EXCEPTION 'overdue_reminder_frequency_days out of range' USING ERRCODE = '22003';
  END IF;
  IF v_large < 0 OR v_exp_above < 0 THEN
    RAISE EXCEPTION 'thresholds must be non-negative' USING ERRCODE = '22003';
  END IF;
  IF v_hour < 0 OR v_hour > 23 THEN
    RAISE EXCEPTION 'digest_send_hour must be 0..23' USING ERRCODE = '22003';
  END IF;

  INSERT INTO public.notification_alert_settings AS nas (
    organization_id, business_id,
    low_stock_warning_threshold, low_stock_critical_threshold, out_of_stock_alert,
    invoice_reminder_days_before, overdue_reminder_frequency_days, overdue_escalation_enabled,
    payment_received_notify, large_payment_threshold, expense_approval_required_above,
    daily_digest_enabled, weekly_digest_enabled, digest_send_hour, digest_timezone,
    updated_at
  ) VALUES (
    _organization_id, _business_id,
    v_warn, v_crit, v_oos,
    v_inv_days, v_over_days, v_over_esc,
    v_pay_notify, v_large, v_exp_above,
    v_daily, v_weekly, v_hour, v_tz,
    now()
  )
  ON CONFLICT (organization_id, business_id) DO UPDATE SET
    low_stock_warning_threshold      = EXCLUDED.low_stock_warning_threshold,
    low_stock_critical_threshold     = EXCLUDED.low_stock_critical_threshold,
    out_of_stock_alert               = EXCLUDED.out_of_stock_alert,
    invoice_reminder_days_before     = EXCLUDED.invoice_reminder_days_before,
    overdue_reminder_frequency_days  = EXCLUDED.overdue_reminder_frequency_days,
    overdue_escalation_enabled       = EXCLUDED.overdue_escalation_enabled,
    payment_received_notify          = EXCLUDED.payment_received_notify,
    large_payment_threshold          = EXCLUDED.large_payment_threshold,
    expense_approval_required_above  = EXCLUDED.expense_approval_required_above,
    daily_digest_enabled             = EXCLUDED.daily_digest_enabled,
    weekly_digest_enabled            = EXCLUDED.weekly_digest_enabled,
    digest_send_hour                 = EXCLUDED.digest_send_hour,
    digest_timezone                  = EXCLUDED.digest_timezone,
    updated_at                       = now()
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.upsert_notification_alert_settings(uuid, uuid, jsonb) TO authenticated;
