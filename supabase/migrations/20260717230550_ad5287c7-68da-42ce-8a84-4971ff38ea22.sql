
-- WMS Phase 10 — Labour management

CREATE TABLE IF NOT EXISTS public.wms_task_standards (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id       uuid NOT NULL,
  task_type         public.wms_task_type NOT NULL,
  uom               text NOT NULL DEFAULT 'unit',
  seconds_per_uom   numeric NOT NULL CHECK (seconds_per_uom > 0),
  is_active         boolean NOT NULL DEFAULT true,
  notes             text,
  created_by        uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, task_type, uom)
);

CREATE INDEX IF NOT EXISTS wms_task_standards_biz_idx
  ON public.wms_task_standards (business_id, is_active);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.wms_task_standards TO authenticated;
GRANT ALL ON public.wms_task_standards TO service_role;

ALTER TABLE public.wms_task_standards ENABLE ROW LEVEL SECURITY;

CREATE POLICY "wms_task_standards_select" ON public.wms_task_standards
  FOR SELECT TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id));

CREATE POLICY "wms_task_standards_write" ON public.wms_task_standards
  FOR ALL TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id)
         AND public.user_has_module_permission(auth.uid(), business_id, 'inventory', 'write'))
  WITH CHECK (public.user_can_access_business(auth.uid(), business_id)
              AND public.user_has_module_permission(auth.uid(), business_id, 'inventory', 'write'));

CREATE OR REPLACE FUNCTION public._touch_wms_task_standards_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS trg_wms_task_standards_updated_at ON public.wms_task_standards;
CREATE TRIGGER trg_wms_task_standards_updated_at
  BEFORE UPDATE ON public.wms_task_standards
  FOR EACH ROW EXECUTE FUNCTION public._touch_wms_task_standards_updated_at();

ALTER TABLE public.wms_tasks
  ADD COLUMN IF NOT EXISTS earned_seconds numeric,
  ADD COLUMN IF NOT EXISTS actual_seconds numeric;

CREATE OR REPLACE FUNCTION public._wms_stamp_labour_metrics()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_std numeric;
  v_qty numeric;
BEGIN
  IF TG_OP = 'UPDATE'
     AND current_setting('role', true) <> 'service_role'
     AND (NEW.earned_seconds IS DISTINCT FROM OLD.earned_seconds
          OR NEW.actual_seconds IS DISTINCT FROM OLD.actual_seconds)
     AND NEW.state IS NOT DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION 'wms_tasks.earned_seconds / actual_seconds are managed by the labour trigger';
  END IF;

  IF NEW.state = 'done' AND (OLD.state IS DISTINCT FROM 'done') THEN
    IF NEW.completed_at IS NULL THEN NEW.completed_at := now(); END IF;
    IF NEW.started_at IS NOT NULL THEN
      NEW.actual_seconds := GREATEST(0, EXTRACT(EPOCH FROM (NEW.completed_at - NEW.started_at)));
    ELSE
      NEW.actual_seconds := 0;
    END IF;

    v_qty := COALESCE(NEW.quantity, 1);
    SELECT seconds_per_uom INTO v_std
      FROM public.wms_task_standards
     WHERE business_id = NEW.business_id
       AND task_type   = NEW.task_type
       AND is_active
     ORDER BY (uom = 'unit') ASC
     LIMIT 1;

    NEW.earned_seconds := COALESCE(v_std, 0) * v_qty;
  END IF;

  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_wms_tasks_labour_metrics ON public.wms_tasks;
CREATE TRIGGER trg_wms_tasks_labour_metrics
  BEFORE UPDATE ON public.wms_tasks
  FOR EACH ROW EXECUTE FUNCTION public._wms_stamp_labour_metrics();

CREATE OR REPLACE VIEW public.wms_operator_productivity_view
WITH (security_invoker = true) AS
SELECT
  t.business_id,
  t.warehouse_id,
  t.assignee_user_id                                              AS operator_id,
  (t.completed_at AT TIME ZONE 'UTC')::date                       AS day,
  COUNT(*)                                                        AS tasks_completed,
  COALESCE(SUM(t.earned_seconds), 0)                              AS earned_seconds,
  COALESCE(SUM(t.actual_seconds), 0)                              AS actual_seconds,
  CASE
    WHEN COALESCE(SUM(t.actual_seconds), 0) > 0
    THEN ROUND((COALESCE(SUM(t.earned_seconds),0) / SUM(t.actual_seconds))::numeric, 3)
    ELSE NULL
  END                                                             AS utilisation_ratio
FROM public.wms_tasks t
WHERE t.state = 'done'
  AND t.completed_at IS NOT NULL
  AND t.assignee_user_id IS NOT NULL
GROUP BY t.business_id, t.warehouse_id, t.assignee_user_id, (t.completed_at AT TIME ZONE 'UTC')::date;

GRANT SELECT ON public.wms_operator_productivity_view TO authenticated, service_role;
