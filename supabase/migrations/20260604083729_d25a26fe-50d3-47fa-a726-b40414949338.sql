
-- ============================================================
-- CRM ↔ Projects integration hardening
-- ============================================================

-- 1. crm_lead_items table -------------------------------------------------

CREATE TABLE IF NOT EXISTS public.crm_lead_items (
  id              UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  lead_id         UUID NOT NULL REFERENCES public.crm_leads(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id     UUID REFERENCES public.businesses(id) ON DELETE CASCADE,
  product_id      UUID REFERENCES public.products(id) ON DELETE SET NULL,
  description     TEXT NOT NULL,
  quantity        NUMERIC(15,2) NOT NULL DEFAULT 1,
  unit_price      NUMERIC(15,2) NOT NULL DEFAULT 0,
  discount_percent NUMERIC(5,2) DEFAULT 0,
  tax_rate        NUMERIC(5,2) DEFAULT 0,
  line_total      NUMERIC(15,2) NOT NULL DEFAULT 0,
  sort_order      INTEGER DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.crm_lead_items TO authenticated;
GRANT ALL ON public.crm_lead_items TO service_role;

ALTER TABLE public.crm_lead_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "lead_items_select"
  ON public.crm_lead_items FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.crm_leads l
            WHERE l.id = crm_lead_items.lead_id
              AND l.organization_id = crm_lead_items.organization_id)
  );

CREATE POLICY "lead_items_insert"
  ON public.crm_lead_items FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.crm_leads l
            WHERE l.id = crm_lead_items.lead_id
              AND l.organization_id = crm_lead_items.organization_id)
  );

CREATE POLICY "lead_items_update"
  ON public.crm_lead_items FOR UPDATE TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.crm_leads l
            WHERE l.id = crm_lead_items.lead_id
              AND l.organization_id = crm_lead_items.organization_id)
  );

CREATE POLICY "lead_items_delete"
  ON public.crm_lead_items FOR DELETE TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.crm_leads l
            WHERE l.id = crm_lead_items.lead_id
              AND l.organization_id = crm_lead_items.organization_id)
  );

CREATE INDEX IF NOT EXISTS idx_crm_lead_items_lead ON public.crm_lead_items(lead_id);

-- Auto-recompute line_total + sync lead expected_revenue
CREATE OR REPLACE FUNCTION public.trg_crm_lead_items_recompute()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_lead_id uuid;
  v_total   numeric;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_lead_id := OLD.lead_id;
  ELSE
    NEW.line_total := ROUND(
      COALESCE(NEW.quantity,0) * COALESCE(NEW.unit_price,0)
      * (1 - COALESCE(NEW.discount_percent,0) / 100.0)
    , 2);
    v_lead_id := NEW.lead_id;
  END IF;

  SELECT COALESCE(SUM(line_total), 0) INTO v_total
    FROM public.crm_lead_items
   WHERE lead_id = v_lead_id
     AND (TG_OP <> 'DELETE' OR id <> OLD.id);

  UPDATE public.crm_leads
     SET expected_revenue = v_total,
         updated_at = now()
   WHERE id = v_lead_id
     AND v_total > 0;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_crm_lead_items_recompute_iu ON public.crm_lead_items;
CREATE TRIGGER trg_crm_lead_items_recompute_iu
  BEFORE INSERT OR UPDATE OF quantity, unit_price, discount_percent
  ON public.crm_lead_items
  FOR EACH ROW EXECUTE FUNCTION public.trg_crm_lead_items_recompute();

DROP TRIGGER IF EXISTS trg_crm_lead_items_recompute_aiud ON public.crm_lead_items;
CREATE TRIGGER trg_crm_lead_items_recompute_aiud
  AFTER INSERT OR UPDATE OR DELETE
  ON public.crm_lead_items
  FOR EACH ROW EXECUTE FUNCTION public.trg_crm_lead_items_recompute();

-- updated_at trigger
CREATE OR REPLACE FUNCTION public.trg_touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS trg_crm_lead_items_touch ON public.crm_lead_items;
CREATE TRIGGER trg_crm_lead_items_touch
  BEFORE UPDATE ON public.crm_lead_items
  FOR EACH ROW EXECUTE FUNCTION public.trg_touch_updated_at();

-- 2. Allow 'system' activity entries -------------------------------------

ALTER TABLE public.crm_activities
  DROP CONSTRAINT IF EXISTS crm_activities_activity_type_check;

ALTER TABLE public.crm_activities
  ADD CONSTRAINT crm_activities_activity_type_check
  CHECK (activity_type IN ('call','email','meeting','task','note','deadline','system'));

-- 3. Repair convert_lead_to_contact (was referencing dropped column) -----

CREATE OR REPLACE FUNCTION public.convert_lead_to_contact(p_lead_id uuid)
RETURNS TABLE(id uuid, name text, was_existing boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lead public.crm_leads%ROWTYPE;
  v_existing_id uuid;
  v_existing_name text;
  v_new_id uuid;
  v_new_name text;
  v_company_id uuid;
  v_company_name text;
BEGIN
  SELECT * INTO v_lead
    FROM public.crm_leads
   WHERE crm_leads.id = p_lead_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lead % not found', p_lead_id USING ERRCODE = 'P0002';
  END IF;

  v_existing_id := COALESCE(v_lead.contact_id, v_lead.converted_to_contact_id);
  IF v_existing_id IS NOT NULL THEN
    SELECT c.name INTO v_existing_name
      FROM public.contacts c WHERE c.id = v_existing_id;
    IF v_existing_name IS NOT NULL THEN
      RETURN QUERY SELECT v_existing_id, v_existing_name, true;
      RETURN;
    END IF;
  END IF;

  v_company_id := v_lead.company_contact_id;
  IF v_company_id IS NOT NULL THEN
    SELECT c.name INTO v_company_name FROM public.contacts c WHERE c.id = v_company_id;
  END IF;

  INSERT INTO public.contacts (
    organization_id, business_id, name, email, phone,
    type, notes, is_active, is_company,
    parent_contact_id, commercial_partner_id
  ) VALUES (
    v_lead.organization_id,
    v_lead.business_id,
    COALESCE(NULLIF(v_lead.contact_name, ''), v_lead.name),
    NULLIF(v_lead.email, ''),
    NULLIF(v_lead.phone, ''),
    'customer',
    NULLIF(v_lead.description, ''),
    true,
    false,
    v_company_id,
    v_company_id
  )
  RETURNING contacts.id, contacts.name INTO v_new_id, v_new_name;

  UPDATE public.crm_leads
     SET contact_id              = v_new_id,
         converted_to_contact_id = COALESCE(converted_to_contact_id, v_new_id),
         converted_at            = COALESCE(converted_at, now())
   WHERE crm_leads.id = p_lead_id;

  -- Log system activity
  INSERT INTO public.crm_activities (
    organization_id, lead_id, activity_type, summary, is_done, completed_at, created_by
  ) VALUES (
    v_lead.organization_id, p_lead_id, 'system',
    'Lead converted to contact: ' || v_new_name,
    true, now(), auth.uid()
  );

  RETURN QUERY SELECT v_new_id, v_new_name, false;
END;
$$;

GRANT EXECUTE ON FUNCTION public.convert_lead_to_contact(uuid) TO authenticated;

-- 4. convert_lead_to_estimate -------------------------------------------

CREATE OR REPLACE FUNCTION public.convert_lead_to_estimate(p_lead_id uuid)
RETURNS TABLE(id uuid, estimate_number text, was_existing boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lead     public.crm_leads%ROWTYPE;
  v_business public.businesses%ROWTYPE;
  v_existing_id uuid;
  v_existing_no text;
  v_new_id uuid;
  v_new_no text;
  v_contact_id uuid;
  v_currency text;
  v_total numeric := 0;
  v_branch_id uuid;
BEGIN
  SELECT * INTO v_lead FROM public.crm_leads WHERE crm_leads.id = p_lead_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lead % not found', p_lead_id USING ERRCODE = 'P0002';
  END IF;

  -- Idempotency
  SELECT e.id, e.estimate_number INTO v_existing_id, v_existing_no
    FROM public.estimates e
   WHERE e.source_lead_id = p_lead_id
   ORDER BY e.created_at ASC
   LIMIT 1;

  IF v_existing_id IS NOT NULL THEN
    RETURN QUERY SELECT v_existing_id, v_existing_no, true;
    RETURN;
  END IF;

  -- Ensure contact
  v_contact_id := v_lead.contact_id;
  IF v_contact_id IS NULL THEN
    SELECT cc.id INTO v_contact_id
      FROM public.convert_lead_to_contact(p_lead_id) cc;
  END IF;

  IF v_lead.business_id IS NOT NULL THEN
    SELECT * INTO v_business FROM public.businesses WHERE businesses.id = v_lead.business_id;
  END IF;
  v_currency := COALESCE(v_business.base_currency, 'USD');
  v_branch_id := NULL;

  SELECT public.get_next_estimate_number(v_lead.organization_id) INTO v_new_no;

  SELECT COALESCE(SUM(line_total), 0) INTO v_total
    FROM public.crm_lead_items WHERE lead_id = p_lead_id;
  IF v_total = 0 THEN
    v_total := COALESCE(v_lead.expected_revenue, 0);
  END IF;

  INSERT INTO public.estimates (
    organization_id, business_id, branch_id, estimate_number, contact_id,
    status, issue_date, expiry_date, subtotal, tax_amount, discount_amount, total,
    notes, currency, created_by, source_lead_id
  ) VALUES (
    v_lead.organization_id, v_lead.business_id, v_branch_id,
    COALESCE(v_new_no, 'EST-' || extract(epoch from now())::bigint::text),
    v_contact_id,
    'draft', CURRENT_DATE, CURRENT_DATE + INTERVAL '30 days',
    v_total, 0, 0, v_total,
    NULLIF(v_lead.description, ''),
    v_currency,
    auth.uid(),
    p_lead_id
  ) RETURNING estimates.id, estimates.estimate_number INTO v_new_id, v_new_no;

  -- Copy line items
  INSERT INTO public.estimate_items (
    estimate_id, product_id, description, quantity, unit_price,
    tax_rate, tax_amount, discount_percent, line_total, sort_order
  )
  SELECT v_new_id, li.product_id,
         li.description, li.quantity, li.unit_price,
         COALESCE(li.tax_rate, 0), 0,
         COALESCE(li.discount_percent, 0), li.line_total,
         COALESCE(li.sort_order, 0)
    FROM public.crm_lead_items li
   WHERE li.lead_id = p_lead_id;

  INSERT INTO public.crm_activities (
    organization_id, lead_id, activity_type, summary, is_done, completed_at, created_by
  ) VALUES (
    v_lead.organization_id, p_lead_id, 'system',
    'Estimate created: ' || v_new_no, true, now(), auth.uid()
  );

  RETURN QUERY SELECT v_new_id, v_new_no, false;
END;
$$;

GRANT EXECUTE ON FUNCTION public.convert_lead_to_estimate(uuid) TO authenticated;

-- 5. convert_lead_to_sales_order ----------------------------------------

CREATE OR REPLACE FUNCTION public.convert_lead_to_sales_order(
  p_lead_id uuid, p_project_id uuid DEFAULT NULL
)
RETURNS TABLE(id uuid, so_number text, was_existing boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lead     public.crm_leads%ROWTYPE;
  v_business public.businesses%ROWTYPE;
  v_existing_id uuid;
  v_existing_no text;
  v_new_id uuid;
  v_new_no  text;
  v_contact_id uuid;
  v_currency text;
  v_total numeric := 0;
BEGIN
  SELECT * INTO v_lead FROM public.crm_leads WHERE crm_leads.id = p_lead_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lead % not found', p_lead_id USING ERRCODE = 'P0002';
  END IF;

  SELECT so.id, so.so_number INTO v_existing_id, v_existing_no
    FROM public.sales_orders so
   WHERE so.source_lead_id = p_lead_id
   ORDER BY so.created_at ASC
   LIMIT 1;

  IF v_existing_id IS NOT NULL THEN
    IF p_project_id IS NOT NULL THEN
      UPDATE public.sales_orders
         SET project_id = COALESCE(project_id, p_project_id)
       WHERE sales_orders.id = v_existing_id;
    END IF;
    RETURN QUERY SELECT v_existing_id, v_existing_no, true;
    RETURN;
  END IF;

  v_contact_id := v_lead.contact_id;
  IF v_contact_id IS NULL THEN
    SELECT cc.id INTO v_contact_id FROM public.convert_lead_to_contact(p_lead_id) cc;
  END IF;

  IF v_lead.business_id IS NOT NULL THEN
    SELECT * INTO v_business FROM public.businesses WHERE businesses.id = v_lead.business_id;
  END IF;
  v_currency := COALESCE(v_business.base_currency, 'USD');

  SELECT public.get_next_so_number(v_lead.organization_id) INTO v_new_no;

  SELECT COALESCE(SUM(line_total), 0) INTO v_total
    FROM public.crm_lead_items WHERE lead_id = p_lead_id;
  IF v_total = 0 THEN
    v_total := COALESCE(v_lead.expected_revenue, 0);
  END IF;

  INSERT INTO public.sales_orders (
    organization_id, business_id, so_number, contact_id, status,
    order_date, expected_date, subtotal, tax_amount, discount_amount, total,
    notes, currency, created_by, source_lead_id, project_id
  ) VALUES (
    v_lead.organization_id, v_lead.business_id,
    COALESCE(v_new_no, 'SO-' || extract(epoch from now())::bigint::text),
    v_contact_id, 'draft',
    CURRENT_DATE,
    COALESCE(v_lead.expected_close_date, CURRENT_DATE + INTERVAL '14 days'),
    v_total, 0, 0, v_total,
    NULLIF(v_lead.description, ''),
    v_currency, auth.uid(), p_lead_id, p_project_id
  ) RETURNING sales_orders.id, sales_orders.so_number INTO v_new_id, v_new_no;

  INSERT INTO public.sales_order_items (
    sales_order_id, product_id, description, quantity, unit_price,
    tax_rate, tax_amount, discount_percent, line_total, sort_order, project_id
  )
  SELECT v_new_id, li.product_id, li.description, li.quantity, li.unit_price,
         COALESCE(li.tax_rate, 0), 0,
         COALESCE(li.discount_percent, 0), li.line_total,
         COALESCE(li.sort_order, 0), p_project_id
    FROM public.crm_lead_items li
   WHERE li.lead_id = p_lead_id;

  INSERT INTO public.crm_activities (
    organization_id, lead_id, activity_type, summary, is_done, completed_at, created_by
  ) VALUES (
    v_lead.organization_id, p_lead_id, 'system',
    'Sales order created: ' || v_new_no, true, now(), auth.uid()
  );

  RETURN QUERY SELECT v_new_id, v_new_no, false;
END;
$$;

GRANT EXECUTE ON FUNCTION public.convert_lead_to_sales_order(uuid, uuid) TO authenticated;

-- 6. convert_lead_to_project --------------------------------------------

CREATE OR REPLACE FUNCTION public.convert_lead_to_project(
  p_lead_id uuid, p_sales_order_id uuid DEFAULT NULL
)
RETURNS TABLE(id uuid, project_number text, was_existing boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lead     public.crm_leads%ROWTYPE;
  v_business public.businesses%ROWTYPE;
  v_existing_id uuid;
  v_existing_no text;
  v_new_id uuid;
  v_new_no text;
  v_contact_id uuid;
  v_currency text;
  v_budget numeric;
  v_lead_total numeric;
BEGIN
  SELECT * INTO v_lead FROM public.crm_leads WHERE crm_leads.id = p_lead_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lead % not found', p_lead_id USING ERRCODE = 'P0002';
  END IF;

  SELECT p.id, p.project_number INTO v_existing_id, v_existing_no
    FROM public.projects p
   WHERE p.source_lead_id = p_lead_id
   ORDER BY p.created_at ASC
   LIMIT 1;

  IF v_existing_id IS NOT NULL THEN
    IF p_sales_order_id IS NOT NULL THEN
      UPDATE public.projects
         SET source_sales_order_id = COALESCE(source_sales_order_id, p_sales_order_id)
       WHERE projects.id = v_existing_id;
      UPDATE public.sales_orders
         SET project_id = COALESCE(project_id, v_existing_id)
       WHERE sales_orders.id = p_sales_order_id;
    END IF;
    RETURN QUERY SELECT v_existing_id, v_existing_no, true;
    RETURN;
  END IF;

  v_contact_id := v_lead.contact_id;
  IF v_contact_id IS NULL THEN
    SELECT cc.id INTO v_contact_id FROM public.convert_lead_to_contact(p_lead_id) cc;
  END IF;

  IF v_lead.business_id IS NOT NULL THEN
    SELECT * INTO v_business FROM public.businesses WHERE businesses.id = v_lead.business_id;
  END IF;
  v_currency := COALESCE(v_business.base_currency, 'USD');

  SELECT COALESCE(SUM(line_total), 0) INTO v_lead_total
    FROM public.crm_lead_items WHERE lead_id = p_lead_id;
  v_budget := NULLIF(GREATEST(v_lead_total, COALESCE(v_lead.expected_revenue, 0)), 0);

  SELECT public.get_next_project_number(v_lead.organization_id) INTO v_new_no;

  INSERT INTO public.projects (
    organization_id, business_id, project_number, name, description, status,
    customer_id, budget, budget_type, is_billable, pricing_type,
    allow_timesheets, currency, created_by, source_lead_id, source_sales_order_id
  ) VALUES (
    v_lead.organization_id, v_lead.business_id,
    COALESCE(v_new_no, 'PROJ-' || extract(epoch from now())::bigint::text),
    COALESCE(NULLIF(v_lead.name, ''), 'New Project'),
    NULLIF(v_lead.description, ''),
    'active', v_contact_id, v_budget,
    CASE WHEN v_budget IS NULL THEN 'none' ELSE 'fixed' END,
    true, 'fixed_price', true,
    v_currency, auth.uid(), p_lead_id, p_sales_order_id
  ) RETURNING projects.id, projects.project_number INTO v_new_id, v_new_no;

  -- Seed kanban stages
  INSERT INTO public.project_stages (project_id, name, sequence, is_closed)
  VALUES
    (v_new_id, 'To Do', 0, false),
    (v_new_id, 'In Progress', 1, false),
    (v_new_id, 'Review', 2, false),
    (v_new_id, 'Done', 3, true);

  -- Close the loop: link the SO back to this project
  IF p_sales_order_id IS NOT NULL THEN
    UPDATE public.sales_orders
       SET project_id = COALESCE(project_id, v_new_id)
     WHERE sales_orders.id = p_sales_order_id;
    UPDATE public.sales_order_items
       SET project_id = COALESCE(project_id, v_new_id)
     WHERE sales_order_id = p_sales_order_id;
  END IF;

  INSERT INTO public.crm_activities (
    organization_id, lead_id, activity_type, summary, is_done, completed_at, created_by
  ) VALUES (
    v_lead.organization_id, p_lead_id, 'system',
    'Project created: ' || v_new_no, true, now(), auth.uid()
  );

  RETURN QUERY SELECT v_new_id, v_new_no, false;
END;
$$;

GRANT EXECUTE ON FUNCTION public.convert_lead_to_project(uuid, uuid) TO authenticated;
