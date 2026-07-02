
CREATE TYPE public.label_engine AS ENUM ('zpl','epl','escpos','pdf');

CREATE TABLE public.label_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  branch_id uuid NULL,
  kind text NOT NULL,
  template_key text NOT NULL,
  name text NOT NULL,
  engine public.label_engine NOT NULL,
  body text NOT NULL,
  width_mm numeric NULL,
  height_mm numeric NULL,
  is_default boolean NOT NULL DEFAULT false,
  version int NOT NULL DEFAULT 1,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NULL
);

CREATE UNIQUE INDEX label_templates_branch_key_uniq
  ON public.label_templates (org_id, branch_id, template_key) WHERE branch_id IS NOT NULL;
CREATE UNIQUE INDEX label_templates_org_key_uniq
  ON public.label_templates (org_id, template_key) WHERE branch_id IS NULL;
CREATE INDEX label_templates_kind_idx ON public.label_templates (org_id, kind, active);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.label_templates TO authenticated;
GRANT ALL ON public.label_templates TO service_role;

ALTER TABLE public.label_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY label_templates_org_read ON public.label_templates FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_business_access uba WHERE uba.user_id = auth.uid() AND uba.business_id = label_templates.org_id));

CREATE POLICY label_templates_admin_write ON public.label_templates FOR ALL TO authenticated
  USING (
    public.has_role(auth.uid(), label_templates.org_id, 'admin'::app_role)
    OR public.has_role(auth.uid(), label_templates.org_id, 'owner'::app_role)
  )
  WITH CHECK (
    public.has_role(auth.uid(), label_templates.org_id, 'admin'::app_role)
    OR public.has_role(auth.uid(), label_templates.org_id, 'owner'::app_role)
  );

CREATE OR REPLACE FUNCTION public.tg_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

CREATE TRIGGER label_templates_touch BEFORE UPDATE ON public.label_templates
  FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();

CREATE TYPE public.printer_workflow AS ENUM (
  'receiving','shipping','shelf_edge','product_tag',
  'kitchen_hot','kitchen_bar','bar','payslip','asset_tag','generic'
);

CREATE TABLE public.printer_workflow_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  branch_id uuid NULL,
  warehouse_id uuid NULL,
  workflow public.printer_workflow NOT NULL,
  printer_profile_id uuid NOT NULL REFERENCES public.printer_profiles(id) ON DELETE CASCADE,
  priority int NOT NULL DEFAULT 100,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NULL
);

CREATE INDEX printer_workflow_bindings_lookup_idx
  ON public.printer_workflow_bindings (org_id, workflow, active, priority);
CREATE INDEX printer_workflow_bindings_scope_idx
  ON public.printer_workflow_bindings (org_id, branch_id, warehouse_id, workflow);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.printer_workflow_bindings TO authenticated;
GRANT ALL ON public.printer_workflow_bindings TO service_role;

ALTER TABLE public.printer_workflow_bindings ENABLE ROW LEVEL SECURITY;

CREATE POLICY pwb_org_read ON public.printer_workflow_bindings FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_business_access uba WHERE uba.user_id = auth.uid() AND uba.business_id = printer_workflow_bindings.org_id));

CREATE POLICY pwb_admin_write ON public.printer_workflow_bindings FOR ALL TO authenticated
  USING (
    public.has_role(auth.uid(), printer_workflow_bindings.org_id, 'admin'::app_role)
    OR public.has_role(auth.uid(), printer_workflow_bindings.org_id, 'owner'::app_role)
  )
  WITH CHECK (
    public.has_role(auth.uid(), printer_workflow_bindings.org_id, 'admin'::app_role)
    OR public.has_role(auth.uid(), printer_workflow_bindings.org_id, 'owner'::app_role)
  );

CREATE TRIGGER pwb_touch BEFORE UPDATE ON public.printer_workflow_bindings
  FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();

CREATE OR REPLACE FUNCTION public.resolve_workflow_printer(
  p_org_id uuid, p_workflow public.printer_workflow,
  p_branch_id uuid DEFAULT NULL, p_warehouse_id uuid DEFAULT NULL
) RETURNS TABLE (printer_profile_id uuid, binding_id uuid, scope text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT b.printer_profile_id, b.id,
         CASE
           WHEN b.branch_id IS NOT DISTINCT FROM p_branch_id
            AND b.warehouse_id IS NOT DISTINCT FROM p_warehouse_id THEN 'exact'
           WHEN b.branch_id IS NOT DISTINCT FROM p_branch_id THEN 'branch'
           ELSE 'org'
         END AS scope
  FROM public.printer_workflow_bindings b
  WHERE b.org_id = p_org_id AND b.workflow = p_workflow AND b.active = true
    AND (b.branch_id IS NULL OR b.branch_id = p_branch_id)
    AND (b.warehouse_id IS NULL OR b.warehouse_id = p_warehouse_id)
  ORDER BY
    (b.branch_id IS NOT DISTINCT FROM p_branch_id
     AND b.warehouse_id IS NOT DISTINCT FROM p_warehouse_id) DESC,
    (b.branch_id IS NOT DISTINCT FROM p_branch_id) DESC,
    b.priority ASC
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.resolve_workflow_printer(uuid, public.printer_workflow, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_workflow_printer(uuid, public.printer_workflow, uuid, uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.resolve_label_template(
  p_org_id uuid, p_template_key text, p_branch_id uuid DEFAULT NULL
) RETURNS TABLE (id uuid, engine public.label_engine, body text, version int, kind text, scope text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH ranked AS (
    SELECT t.*,
           CASE WHEN t.branch_id IS NOT DISTINCT FROM p_branch_id THEN 'branch'
                WHEN t.branch_id IS NULL THEN 'org' END AS scope_label,
           CASE WHEN t.branch_id IS NOT DISTINCT FROM p_branch_id THEN 1
                WHEN t.branch_id IS NULL THEN 2 END AS rnk
    FROM public.label_templates t
    WHERE t.org_id = p_org_id AND t.active = true
      AND t.template_key = p_template_key
      AND (t.branch_id IS NULL OR t.branch_id = p_branch_id)
  )
  SELECT id, engine, body, version, kind, scope_label
  FROM ranked ORDER BY rnk ASC, version DESC LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.resolve_label_template(uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_label_template(uuid, text, uuid) TO authenticated, service_role;
