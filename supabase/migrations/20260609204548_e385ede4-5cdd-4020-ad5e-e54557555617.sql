
-- =====================================================================
-- 1. Public pricing snapshot (anon-callable, SECURITY DEFINER)
--    Returns active subscription plans + active USD→{KES,USD,...} rates.
--    Replaces direct anon reads of platform_subscription_plans and
--    platform_exchange_rates from the landing/login pages.
-- =====================================================================
CREATE OR REPLACE FUNCTION public.get_public_pricing_snapshot()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'plans', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', p.id,
          'name', p.name,
          'description', p.description,
          'price_monthly', p.price_monthly,
          'price_yearly', p.price_yearly,
          'features', p.features,
          'is_popular', p.is_popular
        )
        ORDER BY p.sort_order
      )
      FROM public.platform_subscription_plans p
      WHERE p.is_active = true
    ), '[]'::jsonb),
    'rates', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'from_currency', r.from_currency,
          'to_currency', r.to_currency,
          'rate', r.rate
        )
      )
      FROM public.platform_exchange_rates r
      WHERE r.is_active = true
        AND r.from_currency = 'USD'
    ), '[]'::jsonb)
  );
$$;

REVOKE ALL ON FUNCTION public.get_public_pricing_snapshot() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_pricing_snapshot() TO anon, authenticated;

-- =====================================================================
-- 2. Let authenticated users evaluate is_platform_admin in policy checks.
--    Anon is intentionally NOT granted; the snapshot RPC is the only
--    pre-auth path that needs platform data.
-- =====================================================================
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname='public' AND p.proname='is_platform_admin'
  ) THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.is_platform_admin(uuid) TO authenticated';
  END IF;
END$$;

-- =====================================================================
-- 3. Attendance config invariant: cannot turn on geofence_required
--    unless every active employee has a work_location with lat/lng/radius.
-- =====================================================================
CREATE OR REPLACE FUNCTION public.attendance_settings_require_locations()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_missing integer;
BEGIN
  IF NEW.geofence_required IS DISTINCT FROM true THEN
    RETURN NEW;
  END IF;

  -- Only enforce when this is a *transition* to true, or on insert with true.
  IF TG_OP = 'UPDATE' AND OLD.geofence_required = true THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO v_missing
  FROM public.employees e
  LEFT JOIN public.work_locations wl ON wl.id = e.work_location_id
  WHERE e.organization_id = NEW.organization_id
    AND COALESCE(e.is_active, true) = true
    AND e.termination_date IS NULL
    AND (
      e.work_location_id IS NULL
      OR wl.id IS NULL
      OR wl.latitude IS NULL
      OR wl.longitude IS NULL
      OR wl.geofence_radius_m IS NULL
    );

  IF v_missing > 0 THEN
    RAISE EXCEPTION 'GEOFENCE_LOCATIONS_INCOMPLETE: % active employee(s) lack a fully configured work_location (lat/lng/radius). Configure work locations before enabling geofence_required.', v_missing
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS attendance_settings_geofence_guard ON public.attendance_settings;
CREATE TRIGGER attendance_settings_geofence_guard
BEFORE INSERT OR UPDATE OF geofence_required ON public.attendance_settings
FOR EACH ROW
EXECUTE FUNCTION public.attendance_settings_require_locations();
