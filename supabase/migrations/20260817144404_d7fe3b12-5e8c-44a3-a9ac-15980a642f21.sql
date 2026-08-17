ALTER TABLE public.wms_loading_manifests
  ADD CONSTRAINT wms_loading_manifests_carrier_id_fkey
  FOREIGN KEY (carrier_id) REFERENCES public.carriers(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_wms_loading_manifests_carrier_id
  ON public.wms_loading_manifests (carrier_id);