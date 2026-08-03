-- Phase 5 — Yard execution layer: jockey work orders on the wms_tasks fabric.
ALTER TYPE public.wms_task_type ADD VALUE IF NOT EXISTS 'yard_move';

CREATE INDEX IF NOT EXISTS idx_wms_tasks_yard_visit
  ON public.wms_tasks ((payload->>'visit_id'))
  WHERE (payload->>'visit_id') IS NOT NULL;
