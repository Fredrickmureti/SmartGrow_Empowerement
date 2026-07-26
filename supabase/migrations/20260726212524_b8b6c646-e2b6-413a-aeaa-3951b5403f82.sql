
-- =========================================================================
-- Phase 2a: Consolidate hardware registries into device_assignments +
-- device_workflow_bindings. Legacy tables retained until code migration
-- lands (Phase 2b) and are dropped in Phase 2c.
-- =========================================================================

-- 1) Extend device_assignments with printer + workstation columns
ALTER TABLE public.device_assignments
  ADD COLUMN IF NOT EXISTS workstation_id      uuid REFERENCES public.workstations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS device_key          text,
  ADD COLUMN IF NOT EXISTS address             text,
  ADD COLUMN IF NOT EXISTS paper_format        text,
  ADD COLUMN IF NOT EXISTS paper_size          text,
  ADD COLUMN IF NOT EXISTS command_language    text,
  ADD COLUMN IF NOT EXISTS dpi                 integer,
  ADD COLUMN IF NOT EXISTS escpos_codepage     text,
  ADD COLUMN IF NOT EXISTS columns_override    integer,
  ADD COLUMN IF NOT EXISTS margin_cols         integer,
  ADD COLUMN IF NOT EXISTS font                text,
  ADD COLUMN IF NOT EXISTS cutter              text,
  ADD COLUMN IF NOT EXISTS qr_native           boolean,
  ADD COLUMN IF NOT EXISTS code128_native      boolean,
  ADD COLUMN IF NOT EXISTS is_calibrated       boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS margins_mm          jsonb   NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS supported_media_ids uuid[]  NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS notes               text;

CREATE UNIQUE INDEX IF NOT EXISTS device_assignments_workstation_device_key_uq
  ON public.device_assignments (workstation_id, device_key)
  WHERE workstation_id IS NOT NULL AND device_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS device_assignments_role_org_idx
  ON public.device_assignments (organization_id, role) WHERE enabled = true;

-- 2) device_workflow_bindings (replaces printer_workflow_bindings)
CREATE TABLE IF NOT EXISTS public.device_workflow_bindings (
  id                    uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id       uuid NOT NULL,
  device_assignment_id  uuid NOT NULL REFERENCES public.device_assignments(id) ON DELETE CASCADE,
  workflow              public.printer_workflow NOT NULL,
  branch_id             uuid,
  warehouse_id          uuid,
  priority              integer NOT NULL DEFAULT 100,
  active                boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid
);

CREATE UNIQUE INDEX IF NOT EXISTS device_workflow_bindings_scope_uq
  ON public.device_workflow_bindings (
    organization_id, workflow,
    COALESCE(branch_id,    '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(warehouse_id, '00000000-0000-0000-0000-000000000000'::uuid),
    device_assignment_id
  );

CREATE INDEX IF NOT EXISTS device_workflow_bindings_lookup_idx
  ON public.device_workflow_bindings (organization_id, workflow, active);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.device_workflow_bindings TO authenticated;
GRANT ALL ON public.device_workflow_bindings TO service_role;

ALTER TABLE public.device_workflow_bindings ENABLE ROW LEVEL SECURITY;

CREATE POLICY dwb_org_read ON public.device_workflow_bindings
  FOR SELECT TO authenticated
  USING (organization_id IN (
    SELECT ur.organization_id FROM public.user_roles ur WHERE ur.user_id = auth.uid()
  ));

CREATE POLICY dwb_admin_write ON public.device_workflow_bindings
  FOR ALL TO authenticated
  USING (
    public.has_role(auth.uid(), organization_id, 'admin'::app_role)
    OR public.has_role(auth.uid(), organization_id, 'owner'::app_role)
  )
  WITH CHECK (
    public.has_role(auth.uid(), organization_id, 'admin'::app_role)
    OR public.has_role(auth.uid(), organization_id, 'owner'::app_role)
  );

CREATE TRIGGER device_workflow_bindings_set_updated_at
  BEFORE UPDATE ON public.device_workflow_bindings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 3a) Populate hardware columns on already-linked device_assignments rows
UPDATE public.device_assignments da
SET
  address             = COALESCE(da.address, pp.address),
  paper_format        = COALESCE(da.paper_format, pp.paper_format),
  paper_size          = COALESCE(da.paper_size, pp.paper_size),
  command_language    = COALESCE(da.command_language, pp.command_language),
  dpi                 = COALESCE(da.dpi, pp.dpi),
  escpos_codepage     = COALESCE(da.escpos_codepage, pp.escpos_codepage),
  columns_override    = COALESCE(da.columns_override, pp.columns_override),
  margin_cols         = COALESCE(da.margin_cols, pp.margin_cols),
  font                = COALESCE(da.font, pp.font),
  cutter              = COALESCE(da.cutter, pp.cutter),
  qr_native           = COALESCE(da.qr_native, pp.qr_native),
  code128_native      = COALESCE(da.code128_native, pp.code128_native),
  is_calibrated       = pp.is_calibrated,
  margins_mm          = pp.margins_mm,
  supported_media_ids = pp.supported_media_ids,
  notes               = COALESCE(da.notes, pp.notes),
  display_name        = COALESCE(NULLIF(da.display_name, ''), pp.label)
FROM public.printer_profiles pp
WHERE da.source_config_id = pp.id;

-- 3b) Mirror orphan printer_profiles into device_assignments
INSERT INTO public.device_assignments (
  organization_id, business_id, scope_kind, scope_id, role, transport, driver,
  display_name, config, capabilities, enabled, is_default, status, source_config_id,
  address, paper_format, paper_size, command_language, dpi, escpos_codepage,
  columns_override, margin_cols, font, cutter, qr_native, code128_native,
  is_calibrated, margins_mm, supported_media_ids, notes
)
SELECT
  b.organization_id, pp.business_id, 'tenant', NULL,
  CASE
    WHEN pp.command_language IN ('zpl','epl')           THEN 'label_printer'
    WHEN pp.command_language = 'escpos'
      OR pp.paper_format IN ('80mm','58mm','40mm')      THEN 'receipt_printer'
    ELSE                                                     'a4_printer'
  END,
  pp.transport,
  'generic',
  pp.label, '{}'::jsonb, '{}'::jsonb, pp.is_active, false, 'unknown', pp.id,
  pp.address, pp.paper_format, pp.paper_size, pp.command_language, pp.dpi, pp.escpos_codepage,
  pp.columns_override, pp.margin_cols, pp.font, pp.cutter, pp.qr_native, pp.code128_native,
  pp.is_calibrated, pp.margins_mm, pp.supported_media_ids, pp.notes
FROM public.printer_profiles pp
JOIN public.businesses b ON b.id = pp.business_id
WHERE NOT EXISTS (
  SELECT 1 FROM public.device_assignments da WHERE da.source_config_id = pp.id
);

-- 4) printer_workflow_bindings → device_workflow_bindings
INSERT INTO public.device_workflow_bindings (
  organization_id, device_assignment_id, workflow, branch_id, warehouse_id,
  priority, active, created_at, updated_at, created_by
)
SELECT
  pwb.org_id, da.id, pwb.workflow, pwb.branch_id, pwb.warehouse_id,
  pwb.priority, pwb.active, pwb.created_at, pwb.updated_at, pwb.created_by
FROM public.printer_workflow_bindings pwb
JOIN public.device_assignments da ON da.source_config_id = pwb.printer_profile_id
WHERE NOT EXISTS (
  SELECT 1 FROM public.device_workflow_bindings dwb
  WHERE dwb.organization_id      = pwb.org_id
    AND dwb.device_assignment_id = da.id
    AND dwb.workflow             = pwb.workflow
    AND dwb.branch_id    IS NOT DISTINCT FROM pwb.branch_id
    AND dwb.warehouse_id IS NOT DISTINCT FROM pwb.warehouse_id
);

-- 5) workstation_devices → device_assignments (station-scoped rows)
INSERT INTO public.device_assignments (
  organization_id, business_id, scope_kind, scope_id, role, transport, driver,
  display_name, config, capabilities, enabled, is_default, status, last_seen_at,
  workstation_id, device_key
)
SELECT
  wd.organization_id, NULL, 'station', wd.workstation_id,
  wd.role, wd.transport, COALESCE(wd.driver, 'generic'),
  COALESCE(NULLIF(wd.name, ''), wd.device_key),
  COALESCE(wd.metadata, '{}'::jsonb),
  COALESCE(wd.capabilities, '{}'::jsonb),
  true, false, COALESCE(wd.health, 'unknown'), wd.last_seen_at,
  wd.workstation_id, wd.device_key
FROM public.workstation_devices wd
WHERE NOT EXISTS (
  SELECT 1 FROM public.device_assignments da
  WHERE da.workstation_id = wd.workstation_id AND da.device_key = wd.device_key
);

-- 6) document_print_policies.device_assignment_id
ALTER TABLE public.document_print_policies
  ADD COLUMN IF NOT EXISTS device_assignment_id uuid
    REFERENCES public.device_assignments(id) ON DELETE SET NULL;

UPDATE public.document_print_policies dpp
SET device_assignment_id = da.id
FROM public.device_assignments da
WHERE dpp.device_assignment_id IS NULL
  AND dpp.printer_profile_id IS NOT NULL
  AND dpp.printer_profile_id = da.source_config_id;

CREATE INDEX IF NOT EXISTS dpp_device_assignment_idx
  ON public.document_print_policies (device_assignment_id)
  WHERE device_assignment_id IS NOT NULL;

-- 7) New canonical resolver RPC
CREATE OR REPLACE FUNCTION public.resolve_device_for_workflow(
  p_org_id       uuid,
  p_workflow     public.printer_workflow,
  p_branch_id    uuid DEFAULT NULL,
  p_warehouse_id uuid DEFAULT NULL
) RETURNS TABLE(device_assignment_id uuid, binding_id uuid, scope text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT b.device_assignment_id, b.id,
         CASE
           WHEN b.branch_id    IS NOT DISTINCT FROM p_branch_id
            AND b.warehouse_id IS NOT DISTINCT FROM p_warehouse_id THEN 'exact'
           WHEN b.branch_id    IS NOT DISTINCT FROM p_branch_id     THEN 'branch'
           ELSE 'org'
         END AS scope
  FROM public.device_workflow_bindings b
  JOIN public.device_assignments da ON da.id = b.device_assignment_id AND da.enabled = true
  WHERE b.organization_id = p_org_id
    AND b.workflow        = p_workflow
    AND b.active          = true
    AND (b.branch_id    IS NULL OR b.branch_id    = p_branch_id)
    AND (b.warehouse_id IS NULL OR b.warehouse_id = p_warehouse_id)
  ORDER BY
    (b.branch_id IS NOT DISTINCT FROM p_branch_id
     AND b.warehouse_id IS NOT DISTINCT FROM p_warehouse_id) DESC,
    (b.branch_id IS NOT DISTINCT FROM p_branch_id) DESC,
    b.priority ASC
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.resolve_device_for_workflow(uuid, public.printer_workflow, uuid, uuid)
  TO authenticated, service_role;

-- 8) Rewrite legacy resolve_workflow_printer to read the new binding table.
--    Returns source_config_id when present (so existing callers cross-refing
--    printer_profiles still resolve), otherwise falls back to the device
--    assignment id — post-drop the same id serves both roles.
CREATE OR REPLACE FUNCTION public.resolve_workflow_printer(
  p_org_id       uuid,
  p_workflow     public.printer_workflow,
  p_branch_id    uuid DEFAULT NULL,
  p_warehouse_id uuid DEFAULT NULL
) RETURNS TABLE(printer_profile_id uuid, binding_id uuid, scope text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(da.source_config_id, da.id) AS printer_profile_id,
         r.binding_id, r.scope
  FROM public.resolve_device_for_workflow(p_org_id, p_workflow, p_branch_id, p_warehouse_id) r
  JOIN public.device_assignments da ON da.id = r.device_assignment_id;
$$;

-- 9) Drop dead legacy trigger + function (source table pos_hardware_configs
--    was removed in an earlier wave; the mirror is a no-op with a dangling
--    reference).
DROP FUNCTION IF EXISTS public.mirror_pos_hw_config_to_device_assignments() CASCADE;
