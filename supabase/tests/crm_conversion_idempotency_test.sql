-- crm_conversion_idempotency_test.sql
--
-- Verifies the three SECURITY DEFINER lead-conversion RPCs are idempotent
-- (second call returns the existing downstream row with was_existing=true,
-- and never creates a duplicate), and that the cross-link branch on
-- convert_lead_to_project / convert_lead_to_sales_order correctly stitches
-- sales_orders.project_id ↔ projects.source_sales_order_id.
BEGIN;
  DO $$
  DECLARE
    v_org uuid; v_biz uuid;
    v_lead uuid;
    v_est1 uuid; v_est2 uuid; v_est_was2 boolean;
    v_so1  uuid; v_so2  uuid; v_so_was2  boolean;
    v_pj1  uuid; v_pj2  uuid; v_pj_was2  boolean;
    v_n_est int; v_n_so int; v_n_pj int;
    v_so_proj uuid; v_pj_so uuid;
  BEGIN
    SELECT organization_id, id INTO v_org, v_biz FROM public.businesses LIMIT 1;
    -- Phase 0 (CRM audit, D1): this block used to `RETURN` silently when no
    -- business existed. That skip is exactly why nobody noticed that every
    -- convert_lead_to_* RPC aborts on a NOT NULL violation
    -- (crm_activities.business_id). A conversion contract test that can
    -- silently pass without exercising a conversion is worthless — fail loudly.
    IF v_biz IS NULL THEN
      RAISE EXCEPTION
        'no business row available — the CRM conversion contract cannot be exercised (this test must never skip)';
    END IF;


    INSERT INTO public.crm_leads
      (organization_id, business_id, lead_number, name, expected_revenue)
    VALUES (v_org, v_biz, 'TEST-CONV-' || extract(epoch from now())::bigint, 'pgtap conv lead', 0)
    RETURNING id INTO v_lead;

    INSERT INTO public.crm_lead_items
      (lead_id, organization_id, business_id, description, quantity, unit_price)
    VALUES (v_lead, v_org, v_biz, 'A', 1, 100),
           (v_lead, v_org, v_biz, 'B', 2,  50);

    -- ===== Estimate idempotency =====
    SELECT id INTO v_est1 FROM public.convert_lead_to_estimate(v_lead);
    SELECT id, was_existing INTO v_est2, v_est_was2 FROM public.convert_lead_to_estimate(v_lead);
    SELECT count(*) INTO v_n_est FROM public.estimates WHERE source_lead_id = v_lead;
    IF v_est1 IS NULL OR v_est1 <> v_est2 OR NOT v_est_was2 OR v_n_est <> 1 THEN
      RAISE EXCEPTION 'convert_lead_to_estimate not idempotent: e1=% e2=% was=% count=%',
        v_est1, v_est2, v_est_was2, v_n_est;
    END IF;

    -- ===== Sales-order idempotency (no project link first) =====
    SELECT id INTO v_so1 FROM public.convert_lead_to_sales_order(v_lead, NULL);
    SELECT id, was_existing INTO v_so2, v_so_was2 FROM public.convert_lead_to_sales_order(v_lead, NULL);
    SELECT count(*) INTO v_n_so FROM public.sales_orders WHERE source_lead_id = v_lead;
    IF v_so1 IS NULL OR v_so1 <> v_so2 OR NOT v_so_was2 OR v_n_so <> 1 THEN
      RAISE EXCEPTION 'convert_lead_to_sales_order not idempotent: s1=% s2=% was=% count=%',
        v_so1, v_so2, v_so_was2, v_n_so;
    END IF;

    -- ===== Project idempotency + cross-link to existing SO =====
    SELECT id INTO v_pj1 FROM public.convert_lead_to_project(v_lead, v_so1);
    SELECT id, was_existing INTO v_pj2, v_pj_was2 FROM public.convert_lead_to_project(v_lead, v_so1);
    SELECT count(*) INTO v_n_pj FROM public.projects WHERE source_lead_id = v_lead;
    IF v_pj1 IS NULL OR v_pj1 <> v_pj2 OR NOT v_pj_was2 OR v_n_pj <> 1 THEN
      RAISE EXCEPTION 'convert_lead_to_project not idempotent: p1=% p2=% was=% count=%',
        v_pj1, v_pj2, v_pj_was2, v_n_pj;
    END IF;

    -- Cross-link assertions: project ↔ sales order.
    SELECT source_sales_order_id INTO v_pj_so FROM public.projects WHERE id = v_pj1;
    SELECT project_id            INTO v_so_proj FROM public.sales_orders WHERE id = v_so1;
    IF v_pj_so <> v_so1 THEN
      RAISE EXCEPTION 'projects.source_sales_order_id not stitched: got % expected %', v_pj_so, v_so1;
    END IF;
    IF v_so_proj <> v_pj1 THEN
      RAISE EXCEPTION 'sales_orders.project_id not stitched: got % expected %', v_so_proj, v_pj1;
    END IF;
  END $$;
ROLLBACK;