
-- ============================================================
-- Read-only-on-uninstall enforcement
-- ============================================================
-- Helper: returns true when the app row exists AND is_active=true.
-- check_org_app_installed already exists; we re-use it.

CREATE OR REPLACE FUNCTION public.assert_app_installed_for_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _app_id text := TG_ARGV[0];
  _org_id uuid;
  _installed boolean;
BEGIN
  -- Resolve the org id from NEW (INSERT/UPDATE) or OLD (DELETE).
  IF TG_OP = 'DELETE' THEN
    _org_id := OLD.organization_id;
  ELSE
    _org_id := NEW.organization_id;
  END IF;

  IF _org_id IS NULL THEN
    -- Defensive: never block writes that lack an org_id (legacy rows).
    RETURN COALESCE(NEW, OLD);
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.organization_installed_apps oia
    WHERE oia.organization_id = _org_id
      AND oia.app_id = _app_id
      AND oia.is_active = true
  ) INTO _installed;

  IF NOT _installed THEN
    RAISE EXCEPTION 'APP_NOT_INSTALLED: % is not installed for this organization. Reinstall the app to make changes; existing records remain readable.', _app_id
      USING ERRCODE = 'P0001';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

COMMENT ON FUNCTION public.assert_app_installed_for_write() IS
  'Trigger function: blocks INSERT/UPDATE/DELETE on tables belonging to an uninstalled app. Read access remains via RLS.';

-- Attach to payroll-domain write tables. Drop+create makes this idempotent.
DROP TRIGGER IF EXISTS trg_payroll_runs_app_installed ON public.payroll_runs;
CREATE TRIGGER trg_payroll_runs_app_installed
  BEFORE INSERT OR UPDATE OR DELETE ON public.payroll_runs
  FOR EACH ROW EXECUTE FUNCTION public.assert_app_installed_for_write('payroll');

DROP TRIGGER IF EXISTS trg_payslips_app_installed ON public.payslips;
CREATE TRIGGER trg_payslips_app_installed
  BEFORE INSERT OR UPDATE OR DELETE ON public.payslips
  FOR EACH ROW EXECUTE FUNCTION public.assert_app_installed_for_write('payroll');

DROP TRIGGER IF EXISTS trg_employee_loans_app_installed ON public.employee_loans;
CREATE TRIGGER trg_employee_loans_app_installed
  BEFORE INSERT OR UPDATE OR DELETE ON public.employee_loans
  FOR EACH ROW EXECUTE FUNCTION public.assert_app_installed_for_write('payroll');

-- Time Off
DROP TRIGGER IF EXISTS trg_leave_requests_app_installed ON public.leave_requests;
CREATE TRIGGER trg_leave_requests_app_installed
  BEFORE INSERT OR UPDATE OR DELETE ON public.leave_requests
  FOR EACH ROW EXECUTE FUNCTION public.assert_app_installed_for_write('time_off');

-- Attendance
DROP TRIGGER IF EXISTS trg_attendance_app_installed ON public.attendance;
CREATE TRIGGER trg_attendance_app_installed
  BEFORE INSERT OR UPDATE OR DELETE ON public.attendance
  FOR EACH ROW EXECUTE FUNCTION public.assert_app_installed_for_write('attendance');

DROP TRIGGER IF EXISTS trg_timesheets_app_installed ON public.timesheets;
CREATE TRIGGER trg_timesheets_app_installed
  BEFORE INSERT OR UPDATE OR DELETE ON public.timesheets
  FOR EACH ROW EXECUTE FUNCTION public.assert_app_installed_for_write('attendance');


-- ============================================================
-- Trial auto-conversion on plan change
-- ============================================================
-- Marks any active trials as 'converted' when the org's current plan now
-- grants the same app via plan_app_access. Idempotent. Returns count.
CREATE OR REPLACE FUNCTION public.convert_app_trials_on_plan_change(p_org_id uuid DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _converted integer := 0;
BEGIN
  WITH org_plan AS (
    SELECT id AS organization_id, subscription_plan_id
    FROM public.organizations
    WHERE (p_org_id IS NULL OR id = p_org_id)
      AND subscription_plan_id IS NOT NULL
  ),
  candidates AS (
    SELECT ats.id
    FROM public.app_trial_status ats
    JOIN org_plan op ON op.organization_id = ats.organization_id
    JOIN public.plan_app_access paa
      ON paa.subscription_plan_id = op.subscription_plan_id
     AND paa.app_id = ats.app_id
    WHERE ats.status = 'active'
  ),
  upd AS (
    UPDATE public.app_trial_status
    SET status = 'converted',
        converted_at = COALESCE(converted_at, now()),
        updated_at = now()
    WHERE id IN (SELECT id FROM candidates)
    RETURNING 1
  )
  SELECT count(*) INTO _converted FROM upd;

  RETURN _converted;
END;
$$;

COMMENT ON FUNCTION public.convert_app_trials_on_plan_change(uuid) IS
  'Marks active trials as converted when the org plan now grants the app via plan_app_access. Pass NULL to sweep all orgs.';


-- ============================================================
-- Trial expiring notifications (used by check-subscription-expiry cron)
-- ============================================================
CREATE OR REPLACE FUNCTION public.notify_app_trial_expiring(
  p_org_id uuid,
  p_app_id text,
  p_days_left integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _app_name text;
  _admin_id uuid;
BEGIN
  -- Resolve app display name from platform_apps if available.
  SELECT COALESCE(name, p_app_id) INTO _app_name
  FROM public.platform_apps WHERE app_id = p_app_id LIMIT 1;
  IF _app_name IS NULL THEN _app_name := p_app_id; END IF;

  -- Notify all org owners and admins. user_roles is the source of truth.
  FOR _admin_id IN
    SELECT DISTINCT ur.user_id
    FROM public.user_roles ur
    WHERE ur.organization_id = p_org_id
      AND ur.is_active = true
      AND ur.role IN ('super_admin', 'owner', 'admin')
  LOOP
    -- Avoid spamming: skip if a notification for this app/days bucket
    -- already exists in the last 24h.
    IF NOT EXISTS (
      SELECT 1 FROM public.notifications n
      WHERE n.organization_id = p_org_id
        AND n.user_id = _admin_id
        AND n.entity_type = 'app_trial'
        AND n.entity_id IS NULL
        AND n.category = 'subscription'
        AND n.title LIKE '%' || _app_name || '%'
        AND n.created_at > now() - interval '24 hours'
    ) THEN
      INSERT INTO public.notifications (
        organization_id, user_id, type, category, title, message, link,
        entity_type, priority
      ) VALUES (
        p_org_id,
        _admin_id,
        CASE WHEN p_days_left <= 0 THEN 'warning' ELSE 'info' END,
        'subscription',
        CASE
          WHEN p_days_left <= 0 THEN _app_name || ' trial ended'
          WHEN p_days_left = 1 THEN _app_name || ' trial ends tomorrow'
          ELSE _app_name || ' trial ends in ' || p_days_left || ' days'
        END,
        CASE
          WHEN p_days_left <= 0 THEN 'Your free trial has ended. Subscribe to keep using ' || _app_name || ' without interruption.'
          ELSE 'Subscribe before the trial ends to avoid losing access to ' || _app_name || '.'
        END,
        '/settings/apps',
        'app_trial',
        CASE WHEN p_days_left <= 1 THEN 2 ELSE 1 END
      );
    END IF;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION public.notify_app_trial_expiring(uuid, text, integer) IS
  'Emit a per-admin notification for an expiring app trial. Called by check-subscription-expiry cron at T-3, T-1, T-0.';
