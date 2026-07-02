
-- =========================================================================
-- PROJECTS APP — STAGE 1: SCHEMA FOUNDATION
-- =========================================================================

-- ---------- 1. Extend existing project tables ----------------------------

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS pricing_type text NOT NULL DEFAULT 'non_billable'
    CHECK (pricing_type IN ('non_billable','employee_rate','task_rate','project_rate','fixed_price','milestone')),
  ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'USD',
  ADD COLUMN IF NOT EXISTS analytic_account_code text,
  ADD COLUMN IF NOT EXISTS template_id uuid REFERENCES public.projects(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS is_template boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS last_update_status text
    CHECK (last_update_status IN ('on_track','at_risk','off_track')),
  ADD COLUMN IF NOT EXISTS last_update_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_projects_template ON public.projects(template_id) WHERE template_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_projects_is_template ON public.projects(organization_id, is_template) WHERE is_template = true;

ALTER TABLE public.project_tasks
  ADD COLUMN IF NOT EXISTS kanban_state text NOT NULL DEFAULT 'normal'
    CHECK (kanban_state IN ('normal','ready','blocked','done')),
  ADD COLUMN IF NOT EXISTS sequence integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS subtask_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS attachment_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS comment_count integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_project_tasks_stage_sequence
  ON public.project_tasks(stage_id, sequence) WHERE is_active = true;

-- ---------- 2. Add project_id / task_id to existing finance tables --------

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES public.projects(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_invoices_project ON public.invoices(project_id) WHERE project_id IS NOT NULL;

ALTER TABLE public.invoice_items
  ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES public.projects(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS task_id    uuid REFERENCES public.project_tasks(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_invoice_items_project ON public.invoice_items(project_id) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_invoice_items_task    ON public.invoice_items(task_id)    WHERE task_id    IS NOT NULL;

ALTER TABLE public.sales_orders
  ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES public.projects(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_sales_orders_project ON public.sales_orders(project_id) WHERE project_id IS NOT NULL;

ALTER TABLE public.sales_order_items
  ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES public.projects(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS task_id    uuid REFERENCES public.project_tasks(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_sales_order_items_project ON public.sales_order_items(project_id) WHERE project_id IS NOT NULL;

ALTER TABLE public.purchase_orders
  ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES public.projects(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_purchase_orders_project ON public.purchase_orders(project_id) WHERE project_id IS NOT NULL;

ALTER TABLE public.purchase_order_items
  ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES public.projects(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS task_id    uuid REFERENCES public.project_tasks(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_purchase_order_items_project ON public.purchase_order_items(project_id) WHERE project_id IS NOT NULL;

ALTER TABLE public.bills
  ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES public.projects(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS task_id    uuid REFERENCES public.project_tasks(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_bills_project ON public.bills(project_id) WHERE project_id IS NOT NULL;

ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES public.projects(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS task_id    uuid REFERENCES public.project_tasks(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_expenses_project ON public.expenses(project_id) WHERE project_id IS NOT NULL;

ALTER TABLE public.journal_entry_lines
  ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES public.projects(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_journal_entry_lines_project ON public.journal_entry_lines(project_id) WHERE project_id IS NOT NULL;

-- ---------- 3. Helpers: project membership / access ----------------------

CREATE OR REPLACE FUNCTION public.is_project_member(_project_id uuid, _user_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.project_members
    WHERE project_id = _project_id AND user_id = _user_id
  );
$$;

CREATE OR REPLACE FUNCTION public.can_access_project(_project_id uuid, _user_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.projects p
    WHERE p.id = _project_id
      AND public.is_org_member(_user_id, p.organization_id)
      AND (
        p.privacy = 'public'
        OR public.is_project_member(p.id, _user_id)
        OR public.has_role(_user_id, p.organization_id, 'owner'::public.app_role)
        OR public.has_role(_user_id, p.organization_id, 'admin'::public.app_role)
      )
  );
$$;

-- ---------- 4. New table: task_dependencies ------------------------------

CREATE TABLE IF NOT EXISTS public.task_dependencies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id            uuid NOT NULL REFERENCES public.project_tasks(id) ON DELETE CASCADE,
  depends_on_task_id uuid NOT NULL REFERENCES public.project_tasks(id) ON DELETE CASCADE,
  dependency_type    text NOT NULL DEFAULT 'fs'
    CHECK (dependency_type IN ('fs','ss','ff','sf')),
  lag_days           integer NOT NULL DEFAULT 0,
  organization_id    uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  created_by         uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT task_dependencies_no_self CHECK (task_id <> depends_on_task_id),
  CONSTRAINT task_dependencies_unique UNIQUE (task_id, depends_on_task_id)
);
CREATE INDEX IF NOT EXISTS idx_task_deps_task    ON public.task_dependencies(task_id);
CREATE INDEX IF NOT EXISTS idx_task_deps_depends ON public.task_dependencies(depends_on_task_id);

ALTER TABLE public.task_dependencies ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Org members read task dependencies"
  ON public.task_dependencies FOR SELECT TO authenticated
  USING (public.is_org_member(auth.uid(), organization_id));

CREATE POLICY "Project members manage task dependencies"
  ON public.task_dependencies FOR ALL TO authenticated
  USING (
    public.is_org_member(auth.uid(), organization_id)
    AND EXISTS (
      SELECT 1 FROM public.project_tasks t
      WHERE t.id = task_dependencies.task_id
        AND public.can_access_project(t.project_id, auth.uid())
    )
  )
  WITH CHECK (
    public.is_org_member(auth.uid(), organization_id)
    AND EXISTS (
      SELECT 1 FROM public.project_tasks t
      WHERE t.id = task_dependencies.task_id
        AND public.can_access_project(t.project_id, auth.uid())
    )
  );

-- Cycle prevention trigger
CREATE OR REPLACE FUNCTION public.task_dependencies_no_cycle()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_cycle boolean;
BEGIN
  WITH RECURSIVE walk(node) AS (
    SELECT NEW.depends_on_task_id
    UNION
    SELECT d.depends_on_task_id
    FROM public.task_dependencies d
    JOIN walk w ON d.task_id = w.node
  )
  SELECT EXISTS (SELECT 1 FROM walk WHERE node = NEW.task_id) INTO v_cycle;

  IF v_cycle THEN
    RAISE EXCEPTION 'Cyclic task dependency detected';
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_task_dependencies_no_cycle ON public.task_dependencies;
CREATE TRIGGER trg_task_dependencies_no_cycle
  BEFORE INSERT OR UPDATE ON public.task_dependencies
  FOR EACH ROW EXECUTE FUNCTION public.task_dependencies_no_cycle();

-- ---------- 5. New table: project_documents ------------------------------

CREATE TABLE IF NOT EXISTS public.project_documents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id     uuid,
  project_id      uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  task_id         uuid REFERENCES public.project_tasks(id) ON DELETE SET NULL,
  name            text NOT NULL,
  description     text,
  storage_path    text NOT NULL,
  mime_type       text,
  size_bytes      bigint,
  version         integer NOT NULL DEFAULT 1,
  parent_document_id uuid REFERENCES public.project_documents(id) ON DELETE SET NULL,
  visibility      text NOT NULL DEFAULT 'team' CHECK (visibility IN ('public','team','private')),
  uploaded_by     uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_project_documents_project ON public.project_documents(project_id);
CREATE INDEX IF NOT EXISTS idx_project_documents_task    ON public.project_documents(task_id) WHERE task_id IS NOT NULL;

ALTER TABLE public.project_documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Project access reads documents"
  ON public.project_documents FOR SELECT TO authenticated
  USING (public.can_access_project(project_id, auth.uid()));
CREATE POLICY "Project access inserts documents"
  ON public.project_documents FOR INSERT TO authenticated
  WITH CHECK (public.can_access_project(project_id, auth.uid()));
CREATE POLICY "Project access updates documents"
  ON public.project_documents FOR UPDATE TO authenticated
  USING (public.can_access_project(project_id, auth.uid()))
  WITH CHECK (public.can_access_project(project_id, auth.uid()));
CREATE POLICY "Project access deletes documents"
  ON public.project_documents FOR DELETE TO authenticated
  USING (public.can_access_project(project_id, auth.uid()));

-- ---------- 6. New table: task_attachments -------------------------------

CREATE TABLE IF NOT EXISTS public.task_attachments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  task_id         uuid NOT NULL REFERENCES public.project_tasks(id) ON DELETE CASCADE,
  name            text NOT NULL,
  storage_path    text NOT NULL,
  mime_type       text,
  size_bytes      bigint,
  uploaded_by     uuid,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_task_attachments_task ON public.task_attachments(task_id);

ALTER TABLE public.task_attachments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Org members read task attachments"
  ON public.task_attachments FOR SELECT TO authenticated
  USING (public.is_org_member(auth.uid(), organization_id));

CREATE POLICY "Project access manages task attachments"
  ON public.task_attachments FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.project_tasks t
    WHERE t.id = task_attachments.task_id
      AND public.can_access_project(t.project_id, auth.uid())
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.project_tasks t
    WHERE t.id = task_attachments.task_id
      AND public.can_access_project(t.project_id, auth.uid())
  ));

-- ---------- 7. New table: project_updates --------------------------------

CREATE TABLE IF NOT EXISTS public.project_updates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  project_id      uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  status          text NOT NULL CHECK (status IN ('on_track','at_risk','off_track','done')),
  summary         text NOT NULL,
  period_start    date,
  period_end      date,
  progress_pct    integer CHECK (progress_pct BETWEEN 0 AND 100),
  author_id       uuid,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_project_updates_project ON public.project_updates(project_id, created_at DESC);

ALTER TABLE public.project_updates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Project access reads updates"
  ON public.project_updates FOR SELECT TO authenticated
  USING (public.can_access_project(project_id, auth.uid()));
CREATE POLICY "Project access writes updates"
  ON public.project_updates FOR INSERT TO authenticated
  WITH CHECK (public.can_access_project(project_id, auth.uid()));

CREATE OR REPLACE FUNCTION public.sync_project_last_update()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.projects
    SET last_update_status = NEW.status,
        last_update_at = NEW.created_at
    WHERE id = NEW.project_id;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_sync_project_last_update ON public.project_updates;
CREATE TRIGGER trg_sync_project_last_update
  AFTER INSERT ON public.project_updates
  FOR EACH ROW EXECUTE FUNCTION public.sync_project_last_update();

-- ---------- 8. project_recurring_templates -------------------------------

CREATE TABLE IF NOT EXISTS public.project_recurring_templates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  project_id      uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  source_task_id  uuid REFERENCES public.project_tasks(id) ON DELETE SET NULL,
  name            text NOT NULL,
  task_payload    jsonb NOT NULL,
  rrule           text NOT NULL,
  next_run_at     timestamptz NOT NULL,
  last_run_at     timestamptz,
  is_active       boolean NOT NULL DEFAULT true,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_recurring_templates_due     ON public.project_recurring_templates(next_run_at) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_recurring_templates_project ON public.project_recurring_templates(project_id);

ALTER TABLE public.project_recurring_templates ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Project access reads recurring templates"
  ON public.project_recurring_templates FOR SELECT TO authenticated
  USING (public.can_access_project(project_id, auth.uid()));
CREATE POLICY "Project access manages recurring templates"
  ON public.project_recurring_templates FOR ALL TO authenticated
  USING (public.can_access_project(project_id, auth.uid()))
  WITH CHECK (public.can_access_project(project_id, auth.uid()));

-- ---------- 9. cost / revenue analytic ledgers ---------------------------

CREATE TABLE IF NOT EXISTS public.project_cost_entries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id     uuid,
  project_id      uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  task_id         uuid REFERENCES public.project_tasks(id) ON DELETE SET NULL,
  source_type     text NOT NULL CHECK (source_type IN ('timesheet','expense','vendor_bill','purchase_order','manual')),
  source_id       uuid,
  employee_id     uuid REFERENCES public.employees(id) ON DELETE SET NULL,
  hours           numeric,
  amount          numeric NOT NULL DEFAULT 0,
  currency        text NOT NULL DEFAULT 'USD',
  posted_at       timestamptz NOT NULL DEFAULT now(),
  description     text,
  metadata        jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_project_cost_project ON public.project_cost_entries(project_id, posted_at);
CREATE INDEX IF NOT EXISTS idx_project_cost_source  ON public.project_cost_entries(source_type, source_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_project_cost_source
  ON public.project_cost_entries(source_type, source_id)
  WHERE source_id IS NOT NULL AND source_type <> 'manual';

ALTER TABLE public.project_cost_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Project access reads cost entries"
  ON public.project_cost_entries FOR SELECT TO authenticated
  USING (public.can_access_project(project_id, auth.uid()));
CREATE POLICY "Managers insert manual cost entries"
  ON public.project_cost_entries FOR INSERT TO authenticated
  WITH CHECK (
    source_type = 'manual'
    AND public.can_access_project(project_id, auth.uid())
    AND (
      public.has_role(auth.uid(), organization_id, 'owner'::public.app_role)
      OR public.has_role(auth.uid(), organization_id, 'admin'::public.app_role)
      OR public.has_role(auth.uid(), organization_id, 'accountant'::public.app_role)
    )
  );

CREATE TABLE IF NOT EXISTS public.project_revenue_entries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id     uuid,
  project_id      uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  milestone_id    uuid REFERENCES public.project_milestones(id) ON DELETE SET NULL,
  source_type     text NOT NULL CHECK (source_type IN ('invoice','sales_order','milestone','fixed_price','manual')),
  source_id       uuid,
  amount          numeric NOT NULL DEFAULT 0,
  currency        text NOT NULL DEFAULT 'USD',
  posted_at       timestamptz NOT NULL DEFAULT now(),
  description     text,
  metadata        jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_project_revenue_project ON public.project_revenue_entries(project_id, posted_at);
CREATE INDEX IF NOT EXISTS idx_project_revenue_source  ON public.project_revenue_entries(source_type, source_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_project_revenue_source
  ON public.project_revenue_entries(source_type, source_id)
  WHERE source_id IS NOT NULL AND source_type <> 'manual';

ALTER TABLE public.project_revenue_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Project access reads revenue entries"
  ON public.project_revenue_entries FOR SELECT TO authenticated
  USING (public.can_access_project(project_id, auth.uid()));
CREATE POLICY "Managers insert manual revenue entries"
  ON public.project_revenue_entries FOR INSERT TO authenticated
  WITH CHECK (
    source_type = 'manual'
    AND public.can_access_project(project_id, auth.uid())
    AND (
      public.has_role(auth.uid(), organization_id, 'owner'::public.app_role)
      OR public.has_role(auth.uid(), organization_id, 'admin'::public.app_role)
      OR public.has_role(auth.uid(), organization_id, 'accountant'::public.app_role)
    )
  );

-- ---------- 10. updated_at trigger helper --------------------------------

CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS trg_project_documents_touch ON public.project_documents;
CREATE TRIGGER trg_project_documents_touch BEFORE UPDATE ON public.project_documents
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS trg_recurring_templates_touch ON public.project_recurring_templates;
CREATE TRIGGER trg_recurring_templates_touch BEFORE UPDATE ON public.project_recurring_templates
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
