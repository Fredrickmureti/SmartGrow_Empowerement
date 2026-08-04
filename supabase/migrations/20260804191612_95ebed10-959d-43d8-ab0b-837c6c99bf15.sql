-- Phase 1b — the wave spine.
-- Tasks and manifests must point at the wave that created them; today the
-- link lives in metadata JSON, which makes every wave-level progress query a
-- JSON scan and prevents a foreign key from enforcing the relationship.
ALTER TABLE public.wms_tasks
  ADD COLUMN IF NOT EXISTS wave_id uuid REFERENCES public.wms_pick_waves(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_wms_tasks_wave_id ON public.wms_tasks(wave_id) WHERE wave_id IS NOT NULL;

UPDATE public.wms_tasks t
SET wave_id = t.source_doc_id
WHERE t.wave_id IS NULL
  AND t.source_doc_type = 'wms_pick_wave'
  AND EXISTS (SELECT 1 FROM public.wms_pick_waves w WHERE w.id = t.source_doc_id);

ALTER TABLE public.wms_loading_manifests
  ADD COLUMN IF NOT EXISTS wave_id uuid REFERENCES public.wms_pick_waves(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_wms_loading_manifests_wave_id
  ON public.wms_loading_manifests(wave_id) WHERE wave_id IS NOT NULL;

-- Planning columns. A wave is a commitment of capacity against a departure,
-- so it must be able to name the carrier, the dock and the cut-off it serves.
ALTER TABLE public.wms_pick_waves
  ADD COLUMN IF NOT EXISTS strategy_id uuid,
  ADD COLUMN IF NOT EXISTS carrier_id uuid REFERENCES public.carriers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS carrier_service_id uuid REFERENCES public.carrier_services(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS dock_id uuid REFERENCES public.warehouse_docks(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS appointment_id uuid REFERENCES public.wms_dock_appointments(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cutoff_at timestamptz,
  ADD COLUMN IF NOT EXISTS planned_start_at timestamptz,
  ADD COLUMN IF NOT EXISTS planned_release_at timestamptz,
  ADD COLUMN IF NOT EXISTS priority integer NOT NULL DEFAULT 50,
  ADD COLUMN IF NOT EXISTS estimated_pick_minutes numeric,
  ADD COLUMN IF NOT EXISTS estimated_lines integer,
  ADD COLUMN IF NOT EXISTS estimated_units numeric,
  ADD COLUMN IF NOT EXISTS estimated_cartons integer,
  ADD COLUMN IF NOT EXISTS readiness jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS readiness_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS released_by uuid,
  ADD COLUMN IF NOT EXISTS suspended_reason text;

CREATE INDEX IF NOT EXISTS idx_wms_pick_waves_state_wh
  ON public.wms_pick_waves(business_id, warehouse_id, state);
CREATE INDEX IF NOT EXISTS idx_wms_pick_waves_cutoff
  ON public.wms_pick_waves(cutoff_at) WHERE cutoff_at IS NOT NULL;