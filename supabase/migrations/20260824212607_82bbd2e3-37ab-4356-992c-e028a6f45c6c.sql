-- ============================================================================
-- CRM Domain Audit · Phase 1 — "stop the bleeding"
-- Ref: .lovable/plan/crm-domain-audit-rework-contract-2026-08-24.md
--   D1 conversions abort (crm_activities.business_id NOT NULL omitted)
--   D2 SECURITY DEFINER CRM functions with no caller authorization
--   D3 get_next_lead_number = COUNT(*)+1 (non-atomic, non-monotonic)
--   D5 stage/activity/lost-reason/activity-type RLS ignores business_id
--   D6 anon holds full write privileges on every crm_* table
-- No lifecycle/state-machine change here — that is Phase 2.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0. Shared authorization seam for CRM SECURITY DEFINER entry points.
--    Every CRM RPC derives its scope from the ROW, then checks the caller
--    against that row's business — never against an id supplied by the browser.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._crm_assert_lead_access(
  p_lead_id   uuid,
  p_operation text
)
RETURNS public.crm_leads
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_lead public.crm_leads%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'CRM: authentication required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_lead FROM public.crm_leads WHERE crm_leads.id = p_lead_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lead % not found', p_lead_id USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.user_can_access_business(auth.uid(), v_lead.business_id) THEN
    RAISE EXCEPTION 'CRM: not a member of the business owning lead %', p_lead_id
      USING ERRCODE = '42501';
  END IF;

  IF NOT public.user_has_module_permission(
            auth.uid(), v_lead.organization_id, v_lead.business_id,
            'sales', p_operation) THEN
    RAISE EXCEPTION 'CRM: missing sales.% permission', p_operation
      USING ERRCODE = '42501';
  END IF;

  RETURN v_lead;
END;
$$;

REVOKE ALL ON FUNCTION public._crm_assert_lead_access(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._crm_assert_lead_access(uuid, text) TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 1. D3 · atomic, business-aware lead numbering.
--    Delegates to the shared numbering engine (advisory-locked, parses only
--    the trailing counter, collision guard). Org-wide scope is preserved
--    because UNIQUE(organization_id, lead_number) is org-wide.
-- ----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.get_next_lead_number(uuid);

CREATE OR REPLACE FUNCTION public.get_next_lead_number(
  p_org_id      uuid,
  p_business_id uuid DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'CRM: authentication required' USING ERRCODE = '42501';
  END IF;

  IF p_business_id IS NOT NULL THEN
    IF NOT public.user_can_access_business(auth.uid(), p_business_id) THEN
      RAISE EXCEPTION 'CRM: not a member of business %', p_business_id
        USING ERRCODE = '42501';
    END IF;
    IF NOT public.user_has_module_permission(
              auth.uid(), p_org_id, p_business_id, 'sales', 'create') THEN
      RAISE EXCEPTION 'CRM: missing sales.create permission' USING ERRCODE = '42501';
    END IF;
  ELSIF NOT EXISTS (
    SELECT 1 FROM public.user_roles ur
     WHERE ur.user_id = auth.uid() AND ur.organization_id = p_org_id
  ) THEN
    RAISE EXCEPTION 'CRM: not a member of organization %', p_org_id
      USING ERRCODE = '42501';
  END IF;

  RETURN public.get_next_document_number(
    p_org_id, NULL, 'LEAD', 'crm_leads', 'lead_number', 'business_id', 4);
END;
$$;

REVOKE ALL ON FUNCTION public.get_next_lead_number(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_next_lead_number(uuid, uuid) TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 2. D2 · calculate_pipeline_value must not read another tenant's pipeline.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.calculate_pipeline_value(
  p_org_id      uuid,
  p_business_id uuid DEFAULT NULL::uuid
)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_value numeric;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'CRM: authentication required' USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles ur
     WHERE ur.user_id = auth.uid() AND ur.organization_id = p_org_id
  ) THEN
    RAISE EXCEPTION 'CRM: not a member of organization %', p_org_id
      USING ERRCODE = '42501';
  END IF;

  IF p_business_id IS NOT NULL
     AND NOT public.user_can_access_business(auth.uid(), p_business_id) THEN
    RAISE EXCEPTION 'CRM: not a member of business %', p_business_id
      USING ERRCODE = '42501';
  END IF;

  IF NOT public.user_has_module_permission(
            auth.uid(), p_org_id, p_business_id, 'sales', 'read') THEN
    RAISE EXCEPTION 'CRM: missing sales.read permission' USING ERRCODE = '42501';
  END IF;

  -- Weighted OPEN pipeline only: open opportunities, neither won nor lost.
  -- Businesses the caller cannot access are excluded even when p_business_id
  -- is NULL, so an org-wide total can never leak another business's figures.
  SELECT COALESCE(SUM(l.expected_revenue * l.probability / 100.0), 0)
    INTO v_value
    FROM public.crm_leads l
   WHERE l.organization_id = p_org_id
     AND (p_business_id IS NULL OR l.business_id = p_business_id)
     AND public.user_can_access_business(auth.uid(), l.business_id)
     AND l.type = 'opportunity'
     AND l.is_active = true
     AND l.won_at IS NULL
     AND l.lost_at IS NULL;

  RETURN v_value;
END;
$$;

REVOKE ALL ON FUNCTION public.calculate_pipeline_value(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.calculate_pipeline_value(uuid, uuid) TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 3. D1 + D2 · convert_lead_to_contact
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.convert_lead_to_contact(p_lead_id uuid)
RETURNS TABLE(id uuid, name text, was_existing boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_lead public.crm_leads%ROWTYPE;
  v_existing_id uuid;
  v_existing_name text;
  v_new_id uuid;
  v_new_name text;
  v_company_id uuid;
BEGIN
  v_lead := public._crm_assert_lead_access(p_lead_id, 'create');

  SELECT * INTO v_lead
    FROM public.crm_leads WHERE crm_leads.id = p_lead_id FOR UPDATE;

  v_existing_id := COALESCE(v_lead.contact_id, v_lead.converted_to_contact_id);
  IF v_existing_id IS NOT NULL THEN
    SELECT c.name INTO v_existing_name FROM public.contacts c WHERE c.id = v_existing_id;
    IF v_existing_name IS NOT NULL THEN
      RETURN QUERY SELECT v_existing_id, v_existing_name, true;
      RETURN;
    END IF;
  END IF;

  v_company_id := v_lead.company_contact_id;
  -- A company contact from another business must never be adopted as parent.
  IF v_company_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.contacts c
     WHERE c.id = v_company_id AND c.business_id = v_lead.business_id
  ) THEN
    RAISE EXCEPTION 'CRM: company contact % does not belong to business %',
      v_company_id, v_lead.business_id USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.contacts (
    organization_id, business_id, name, email, phone,
    type, notes, is_active, is_company,
    parent_contact_id, commercial_partner_id
  ) VALUES (
    v_lead.organization_id, v_lead.business_id,
    COALESCE(NULLIF(v_lead.contact_name, ''), v_lead.name),
    NULLIF(v_lead.email, ''), NULLIF(v_lead.phone, ''),
    'customer', NULLIF(v_lead.description, ''), true, false,
    v_company_id, v_company_id
  )
  RETURNING contacts.id, contacts.name INTO v_new_id, v_new_name;

  UPDATE public.crm_leads
     SET contact_id              = v_new_id,
         converted_to_contact_id = COALESCE(converted_to_contact_id, v_new_id),
         converted_at            = COALESCE(converted_at, now())
   WHERE crm_leads.id = p_lead_id;

  INSERT INTO public.crm_activities (
    organization_id, business_id, lead_id, activity_type, summary,
    is_done, completed_at, created_by
  ) VALUES (
    v_lead.organization_id, v_lead.business_id, p_lead_id, 'system',
    'Lead converted to contact: ' || v_new_name, true, now(), auth.uid()
  );

  RETURN QUERY SELECT v_new_id, v_new_name, false;
END;
$$;

REVOKE ALL ON FUNCTION public.convert_lead_to_contact(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.convert_lead_to_contact(uuid) TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 4. D1 + D2 · convert_lead_to_estimate
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.convert_lead_to_estimate(p_lead_id uuid)
RETURNS TABLE(id uuid, estimate_number text, was_existing boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
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
  v_lead := public._crm_assert_lead_access(p_lead_id, 'create');

  SELECT * INTO v_lead
    FROM public.crm_leads WHERE crm_leads.id = p_lead_id FOR UPDATE;

  SELECT e.id, e.estimate_number INTO v_existing_id, v_existing_no
    FROM public.estimates e
   WHERE e.source_lead_id = p_lead_id
   ORDER BY e.created_at ASC
   LIMIT 1;

  IF v_existing_id IS NOT NULL THEN
    RETURN QUERY SELECT v_existing_id, v_existing_no, true;
    RETURN;
  END IF;

  v_contact_id := v_lead.contact_id;
  IF v_contact_id IS NULL THEN
    SELECT cc.id INTO v_contact_id FROM public.convert_lead_to_contact(p_lead_id) cc;
  ELSIF NOT EXISTS (
    SELECT 1 FROM public.contacts c
     WHERE c.id = v_contact_id AND c.business_id = v_lead.business_id
  ) THEN
    RAISE EXCEPTION 'CRM: lead contact % does not belong to business %',
      v_contact_id, v_lead.business_id USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_business FROM public.businesses WHERE businesses.id = v_lead.business_id;
  v_currency := COALESCE(v_business.base_currency, 'USD');
  v_branch_id := NULL;

  SELECT public.get_next_estimate_number(
           v_lead.organization_id, v_lead.business_id, v_branch_id) INTO v_new_no;

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
    v_lead.organization_id, v_lead.business_id, v_branch_id, v_new_no, v_contact_id,
    'draft', CURRENT_DATE, CURRENT_DATE + INTERVAL '30 days',
    v_total, 0, 0, v_total,
    NULLIF(v_lead.description, ''), v_currency, auth.uid(), p_lead_id
  ) RETURNING estimates.id, estimates.estimate_number INTO v_new_id, v_new_no;

  INSERT INTO public.estimate_items (
    estimate_id, product_id, description, quantity, unit_price,
    tax_rate, tax_amount, discount_percent, line_total, sort_order
  )
  SELECT v_new_id, li.product_id, li.description, li.quantity, li.unit_price,
         COALESCE(li.tax_rate, 0), 0,
         COALESCE(li.discount_percent, 0), li.line_total,
         COALESCE(li.sort_order, 0)
    FROM public.crm_lead_items li
   WHERE li.lead_id = p_lead_id;

  INSERT INTO public.crm_activities (
    organization_id, business_id, lead_id, activity_type, summary,
    is_done, completed_at, created_by
  ) VALUES (
    v_lead.organization_id, v_lead.business_id, p_lead_id, 'system',
    'Estimate created: ' || v_new_no, true, now(), auth.uid()
  );

  RETURN QUERY SELECT v_new_id, v_new_no, false;
END;
$$;

REVOKE ALL ON FUNCTION public.convert_lead_to_estimate(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.convert_lead_to_estimate(uuid) TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 5. D1 + D2 · convert_lead_to_project
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.convert_lead_to_project(
  p_lead_id uuid,
  p_sales_order_id uuid DEFAULT NULL::uuid
)
RETURNS TABLE(id uuid, project_number text, was_existing boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
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
  v_lead := public._crm_assert_lead_access(p_lead_id, 'create');

  SELECT * INTO v_lead
    FROM public.crm_leads WHERE crm_leads.id = p_lead_id FOR UPDATE;

  -- A sales order handed in by the browser must belong to the same business.
  IF p_sales_order_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.sales_orders so
     WHERE so.id = p_sales_order_id AND so.business_id = v_lead.business_id
  ) THEN
    RAISE EXCEPTION 'CRM: sales order % does not belong to business %',
      p_sales_order_id, v_lead.business_id USING ERRCODE = '23514';
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
  ELSIF NOT EXISTS (
    SELECT 1 FROM public.contacts c
     WHERE c.id = v_contact_id AND c.business_id = v_lead.business_id
  ) THEN
    RAISE EXCEPTION 'CRM: lead contact % does not belong to business %',
      v_contact_id, v_lead.business_id USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_business FROM public.businesses WHERE businesses.id = v_lead.business_id;
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
    v_lead.organization_id, v_lead.business_id, v_new_no,
    COALESCE(NULLIF(v_lead.name, ''), 'New Project'),
    NULLIF(v_lead.description, ''),
    'active', v_contact_id, v_budget,
    CASE WHEN v_budget IS NULL THEN 'none' ELSE 'fixed' END,
    true, 'fixed_price', true,
    v_currency, auth.uid(), p_lead_id, p_sales_order_id
  ) RETURNING projects.id, projects.project_number INTO v_new_id, v_new_no;

  INSERT INTO public.project_stages (project_id, name, sequence, is_closed)
  VALUES (v_new_id, 'To Do', 0, false),
         (v_new_id, 'In Progress', 1, false),
         (v_new_id, 'Review', 2, false),
         (v_new_id, 'Done', 3, true);

  IF p_sales_order_id IS NOT NULL THEN
    UPDATE public.sales_orders
       SET project_id = COALESCE(project_id, v_new_id)
     WHERE sales_orders.id = p_sales_order_id;
    UPDATE public.sales_order_items
       SET project_id = COALESCE(project_id, v_new_id)
     WHERE sales_order_id = p_sales_order_id;
  END IF;

  INSERT INTO public.crm_activities (
    organization_id, business_id, lead_id, activity_type, summary,
    is_done, completed_at, created_by
  ) VALUES (
    v_lead.organization_id, v_lead.business_id, p_lead_id, 'system',
    'Project created: ' || v_new_no, true, now(), auth.uid()
  );

  RETURN QUERY SELECT v_new_id, v_new_no, false;
END;
$$;

REVOKE ALL ON FUNCTION public.convert_lead_to_project(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.convert_lead_to_project(uuid, uuid) TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 6. D5 · business-scoped RLS for the CRM configuration + activity tables.
--    crm_stages had a nullable business_id; the table is empty, so the column
--    is tightened now rather than leaving an unscopeable escape hatch.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.crm_stages WHERE business_id IS NULL) THEN
    RAISE EXCEPTION
      'crm_stages rows with NULL business_id exist — backfill before scoping';
  END IF;
END $$;

ALTER TABLE public.crm_stages ALTER COLUMN business_id SET NOT NULL;

-- crm_stages
DROP POLICY IF EXISTS "Users can manage CRM stages in their organization" ON public.crm_stages;
DROP POLICY IF EXISTS "Users can view CRM stages in their organization" ON public.crm_stages;

CREATE POLICY crm_stages_select_v2 ON public.crm_stages
  FOR SELECT TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id)
         AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'sales', 'read'));

CREATE POLICY crm_stages_insert_v2 ON public.crm_stages
  FOR INSERT TO authenticated
  WITH CHECK (public.user_can_access_business(auth.uid(), business_id)
              AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'sales', 'create'));

CREATE POLICY crm_stages_update_v2 ON public.crm_stages
  FOR UPDATE TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id)
         AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'sales', 'write'))
  WITH CHECK (public.user_can_access_business(auth.uid(), business_id)
              AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'sales', 'write'));

CREATE POLICY crm_stages_delete_v2 ON public.crm_stages
  FOR DELETE TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id)
         AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'sales', 'delete'));

-- crm_activities
DROP POLICY IF EXISTS "Users can manage CRM activities in their organization" ON public.crm_activities;
DROP POLICY IF EXISTS "Users can view CRM activities in their organization" ON public.crm_activities;
DROP POLICY IF EXISTS "Admins can delete CRM activities" ON public.crm_activities;

CREATE POLICY crm_activities_select_v2 ON public.crm_activities
  FOR SELECT TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id)
         AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'sales', 'read'));

CREATE POLICY crm_activities_insert_v2 ON public.crm_activities
  FOR INSERT TO authenticated
  WITH CHECK (public.user_can_access_business(auth.uid(), business_id)
              AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'sales', 'create')
              AND EXISTS (SELECT 1 FROM public.crm_leads l
                           WHERE l.id = lead_id
                             AND l.business_id = crm_activities.business_id
                             AND l.organization_id = crm_activities.organization_id));

CREATE POLICY crm_activities_update_v2 ON public.crm_activities
  FOR UPDATE TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id)
         AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'sales', 'write'))
  WITH CHECK (public.user_can_access_business(auth.uid(), business_id)
              AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'sales', 'write'));

CREATE POLICY crm_activities_delete_v2 ON public.crm_activities
  FOR DELETE TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id)
         AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'sales', 'delete'));

-- crm_activity_types
DROP POLICY IF EXISTS "Users can manage CRM activity types in their organization" ON public.crm_activity_types;
DROP POLICY IF EXISTS "Users can view CRM activity types in their organization" ON public.crm_activity_types;

CREATE POLICY crm_activity_types_select_v2 ON public.crm_activity_types
  FOR SELECT TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id)
         AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'sales', 'read'));

CREATE POLICY crm_activity_types_write_v2 ON public.crm_activity_types
  FOR ALL TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id)
         AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'sales', 'write'))
  WITH CHECK (public.user_can_access_business(auth.uid(), business_id)
              AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'sales', 'write'));

-- crm_lost_reasons
DROP POLICY IF EXISTS "Users can manage CRM lost reasons in their organization" ON public.crm_lost_reasons;
DROP POLICY IF EXISTS "Users can view CRM lost reasons in their organization" ON public.crm_lost_reasons;

CREATE POLICY crm_lost_reasons_select_v2 ON public.crm_lost_reasons
  FOR SELECT TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id)
         AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'sales', 'read'));

CREATE POLICY crm_lost_reasons_write_v2 ON public.crm_lost_reasons
  FOR ALL TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id)
         AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'sales', 'write'))
  WITH CHECK (public.user_can_access_business(auth.uid(), business_id)
              AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'sales', 'write'));

-- crm_lead_items: keep the parent-lead join, but scope it through the lead's
-- own business RLS instead of a bare organization_id equality.
DROP POLICY IF EXISTS lead_items_select ON public.crm_lead_items;
DROP POLICY IF EXISTS lead_items_insert ON public.crm_lead_items;
DROP POLICY IF EXISTS lead_items_update ON public.crm_lead_items;
DROP POLICY IF EXISTS lead_items_delete ON public.crm_lead_items;

CREATE POLICY crm_lead_items_select_v2 ON public.crm_lead_items
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.crm_leads l
                  WHERE l.id = crm_lead_items.lead_id
                    AND l.organization_id = crm_lead_items.organization_id
                    AND public.user_can_access_business(auth.uid(), l.business_id)
                    AND public.user_has_module_permission(auth.uid(), l.organization_id, l.business_id, 'sales', 'read')));

CREATE POLICY crm_lead_items_write_v2 ON public.crm_lead_items
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.crm_leads l
                  WHERE l.id = crm_lead_items.lead_id
                    AND l.organization_id = crm_lead_items.organization_id
                    AND public.user_can_access_business(auth.uid(), l.business_id)
                    AND public.user_has_module_permission(auth.uid(), l.organization_id, l.business_id, 'sales', 'write')))
  WITH CHECK (EXISTS (SELECT 1 FROM public.crm_leads l
                       WHERE l.id = crm_lead_items.lead_id
                         AND l.organization_id = crm_lead_items.organization_id
                         AND public.user_can_access_business(auth.uid(), l.business_id)
                         AND public.user_has_module_permission(auth.uid(), l.organization_id, l.business_id, 'sales', 'write')));

-- ----------------------------------------------------------------------------
-- 7. D6 · least privilege. Every CRM policy is auth.uid()-derived, so anon
--    can never legitimately reach these tables.
-- ----------------------------------------------------------------------------
REVOKE ALL ON public.crm_leads, public.crm_lead_items, public.crm_stages,
              public.crm_activities, public.crm_activity_types,
              public.crm_lost_reasons
  FROM anon;

REVOKE ALL ON public.crm_leads, public.crm_lead_items, public.crm_stages,
              public.crm_activities, public.crm_activity_types,
              public.crm_lost_reasons
  FROM authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE
   ON public.crm_leads, public.crm_lead_items, public.crm_stages,
      public.crm_activities, public.crm_activity_types, public.crm_lost_reasons
   TO authenticated;

GRANT ALL
   ON public.crm_leads, public.crm_lead_items, public.crm_stages,
      public.crm_activities, public.crm_activity_types, public.crm_lost_reasons
   TO service_role;