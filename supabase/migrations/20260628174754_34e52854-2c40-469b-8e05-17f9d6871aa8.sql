
-- Phase D
DROP FUNCTION IF EXISTS public.promote_employee_draft(uuid);
DROP FUNCTION IF EXISTS public.promote_employee_draft(uuid, jsonb);
DROP VIEW IF EXISTS public.v_employee_drafts CASCADE;

-- Phase E1: is_active mirror trigger
CREATE OR REPLACE FUNCTION public.tg_employees_sync_is_active()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  NEW.is_active := (NEW.lifecycle_status IN ('active','on_leave','notice','suspended'));
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_employees_sync_is_active ON public.employees;
CREATE TRIGGER trg_employees_sync_is_active
  BEFORE INSERT OR UPDATE OF lifecycle_status, is_active ON public.employees
  FOR EACH ROW EXECUTE FUNCTION public.tg_employees_sync_is_active();
UPDATE public.employees
   SET is_active = (lifecycle_status IN ('active','on_leave','notice','suspended'))
 WHERE is_active IS DISTINCT FROM (lifecycle_status IN ('active','on_leave','notice','suspended'));
COMMENT ON COLUMN public.employees.is_active IS
  'DEPRECATED for direct writes — derived from lifecycle_status by trg_employees_sync_is_active. Kept for back-compat; prefer lifecycle_status / v_employees_canonical.is_operationally_active in new code.';

-- Phase E2: work-email uniqueness per org
DROP INDEX IF EXISTS public.employees_work_email_org_unique;
CREATE UNIQUE INDEX employees_work_email_org_unique
  ON public.employees (organization_id, lower(work_email))
  WHERE work_email IS NOT NULL AND work_email <> '' AND lifecycle_status <> 'draft';
COMMENT ON INDEX public.employees_work_email_org_unique IS
  'Work email unique per organization across operational lifetime. Drafts exempt; NULL/blank allowed (no work address / shared mailbox cases).';

-- Phase E3: drop constraint then re-create as draft-exempt partial unique indexes
ALTER TABLE public.employees
  DROP CONSTRAINT IF EXISTS employees_user_id_organization_id_unique;
DROP INDEX IF EXISTS public.employees_user_id_organization_id_unique;
DROP INDEX IF EXISTS public.employees_user_business_unique;

CREATE UNIQUE INDEX employees_user_id_organization_id_unique
  ON public.employees (user_id, organization_id)
  WHERE user_id IS NOT NULL AND lifecycle_status <> 'draft';

CREATE UNIQUE INDEX employees_user_business_unique
  ON public.employees (user_id, business_id)
  WHERE user_id IS NOT NULL AND business_id IS NOT NULL AND lifecycle_status <> 'draft';

COMMENT ON INDEX public.employees_user_id_organization_id_unique IS
  'A user maps to at most one operational employee per organization. Drafts exempt so a stale in-progress record cannot block linking the real one.';

-- Phase E4: 30-day stale-draft sweep (Workday default)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'discard-stale-employee-drafts') THEN
      PERFORM cron.unschedule('discard-stale-employee-drafts');
    END IF;
    PERFORM cron.schedule(
      'discard-stale-employee-drafts',
      '0 3 * * *',
      $cron$SELECT public.discard_stale_employee_drafts(NULL, NULL, 24 * 30)$cron$
    );
  END IF;
END$$;
