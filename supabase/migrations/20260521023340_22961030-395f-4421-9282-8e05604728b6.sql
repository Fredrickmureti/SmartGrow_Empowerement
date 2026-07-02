
-- =====================================================================
-- Wave 6: persistent-drift cron alert for missing adjustment journals
-- =====================================================================

-- 1) Opt-out flag on the existing notification settings table
ALTER TABLE public.notification_alert_settings
  ADD COLUMN IF NOT EXISTS finance_alert_missing_je_enabled boolean NOT NULL DEFAULT true;

-- 2) Streak tracking table (one row per (business_id, metric))
CREATE TABLE IF NOT EXISTS public.finance_alert_drift_streaks (
  business_id       uuid NOT NULL,
  metric            text NOT NULL,
  consecutive_days  integer NOT NULL DEFAULT 0,
  last_seen_count   integer NOT NULL DEFAULT 0,
  last_evaluated_at timestamptz NOT NULL DEFAULT now(),
  last_notified_at  timestamptz,
  PRIMARY KEY (business_id, metric)
);

ALTER TABLE public.finance_alert_drift_streaks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS drift_streaks_select ON public.finance_alert_drift_streaks;
CREATE POLICY drift_streaks_select
  ON public.finance_alert_drift_streaks
  FOR SELECT
  USING (public.user_can_access_business(auth.uid(), business_id));

-- No INSERT/UPDATE/DELETE policies — writes only via SECURITY DEFINER evaluator.

-- 3) Evaluator RPC. Loops every business, counts the missing-JE backlog using
--    the existing detector, increments/resets the consecutive-day streak, and
--    posts ONE notification per business when the streak crosses 3 days.
CREATE OR REPLACE FUNCTION public.evaluate_missing_je_drift_alerts()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_biz                  RECORD;
  v_count                integer;
  v_enabled              boolean;
  v_streak               integer;
  v_total_businesses     integer := 0;
  v_notifications_posted integer := 0;
  v_alert_threshold      constant integer := 3;
BEGIN
  FOR v_biz IN
    SELECT b.id AS business_id, b.organization_id, b.name
      FROM public.businesses b
     WHERE b.is_active IS TRUE
       AND b.archived_at IS NULL
  LOOP
    v_total_businesses := v_total_businesses + 1;

    -- Per-business opt-out (default = true when row missing)
    SELECT COALESCE(
             (SELECT finance_alert_missing_je_enabled
                FROM public.notification_alert_settings
               WHERE business_id = v_biz.business_id
               LIMIT 1),
             true)
      INTO v_enabled;

    IF NOT v_enabled THEN
      -- Reset streak when alerts are disabled so re-enabling starts fresh.
      DELETE FROM public.finance_alert_drift_streaks
        WHERE business_id = v_biz.business_id AND metric = 'missing_je';
      CONTINUE;
    END IF;

    -- Count current drift backlog (cap at 1000 for the gate; quantity surfaces
    -- in the UI for the actual list).
    SELECT count(*) INTO v_count
      FROM public.list_adjustments_missing_journals(
             v_biz.organization_id, v_biz.business_id, NULL, 1000, 0
           );

    IF v_count = 0 THEN
      DELETE FROM public.finance_alert_drift_streaks
        WHERE business_id = v_biz.business_id AND metric = 'missing_je';
      CONTINUE;
    END IF;

    -- Bump streak
    INSERT INTO public.finance_alert_drift_streaks
      (business_id, metric, consecutive_days, last_seen_count, last_evaluated_at)
    VALUES
      (v_biz.business_id, 'missing_je', 1, v_count, now())
    ON CONFLICT (business_id, metric) DO UPDATE
      SET consecutive_days  = public.finance_alert_drift_streaks.consecutive_days + 1,
          last_seen_count   = EXCLUDED.last_seen_count,
          last_evaluated_at = now()
    RETURNING consecutive_days INTO v_streak;

    -- Fire one notification per crossing of the threshold (and at most one per
    -- business per day — last_notified_at acts as the dedupe key).
    IF v_streak >= v_alert_threshold THEN
      IF NOT EXISTS (
        SELECT 1 FROM public.finance_alert_drift_streaks
         WHERE business_id = v_biz.business_id
           AND metric = 'missing_je'
           AND last_notified_at IS NOT NULL
           AND last_notified_at::date = CURRENT_DATE
      ) THEN
        INSERT INTO public.notifications (
          organization_id, business_id, user_id,
          type, category, title, message,
          link, entity_type, entity_id,
          is_read, is_dismissed, priority
        ) VALUES (
          v_biz.organization_id, v_biz.business_id, NULL,
          'warning', 'finance',
          'Inventory adjustments missing journal entries',
          v_count || ' approved stock adjustment(s) in ' || v_biz.name ||
            ' still have no journal entry after ' || v_streak ||
            ' consecutive days. Open Finance → Inventory reconciliation to post the journal entries individually.',
          '/finance/reconciliation',
          'stock_adjustment', NULL,
          false, false, 2
        );

        UPDATE public.finance_alert_drift_streaks
           SET last_notified_at = now()
         WHERE business_id = v_biz.business_id AND metric = 'missing_je';

        v_notifications_posted := v_notifications_posted + 1;
      END IF;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'evaluated_businesses', v_total_businesses,
    'notifications_posted', v_notifications_posted,
    'evaluated_at',         now()
  );
END;
$$;

REVOKE ALL ON FUNCTION public.evaluate_missing_je_drift_alerts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.evaluate_missing_je_drift_alerts() TO authenticated, service_role;

-- 4) Daily schedule (06:00 UTC). Idempotent — unschedule any prior copy first.
DO $$
BEGIN
  PERFORM cron.unschedule('finance-missing-je-drift');
EXCEPTION WHEN OTHERS THEN
  -- job did not exist; ignore
  NULL;
END $$;

SELECT cron.schedule(
  'finance-missing-je-drift',
  '0 6 * * *',
  $cron$ SELECT public.evaluate_missing_je_drift_alerts(); $cron$
);
