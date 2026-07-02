-- crm_lead_items_total_sync_test.sql
--
-- Verifies the trg_crm_lead_items_recompute trigger:
--   * computes line_total = qty * price * (1 - discount/100) on insert / update
--   * keeps crm_leads.expected_revenue = SUM(line_total) for non-empty sets
--   * does NOT clobber expected_revenue when all items are deleted
--     (header-only leads keep their manually entered expected_revenue — this
--      is intentional back-compat; see migration body where update is
--      gated by `v_total > 0`).
BEGIN;
  DO $$
  DECLARE
    v_org uuid; v_biz uuid;
    v_lead uuid;
    v_item1 uuid; v_item2 uuid;
    v_rev numeric;
    v_item1_total numeric;
  BEGIN
    SELECT organization_id, id INTO v_org, v_biz FROM public.businesses LIMIT 1;
    IF v_biz IS NULL THEN
      RAISE NOTICE 'no business to test against; skipping';
      RETURN;
    END IF;

    -- Seed a lead with no items.
    INSERT INTO public.crm_leads (organization_id, business_id, lead_number, name, expected_revenue)
    VALUES (v_org, v_biz, 'TEST-LEAD-' || extract(epoch from now())::bigint, 'pgtap lead', 999)
    RETURNING id INTO v_lead;

    -- Insert 2 items.
    INSERT INTO public.crm_lead_items
      (lead_id, organization_id, business_id, description, quantity, unit_price, discount_percent)
    VALUES (v_lead, v_org, v_biz, 'item A', 2, 50, 0)
    RETURNING id INTO v_item1;

    INSERT INTO public.crm_lead_items
      (lead_id, organization_id, business_id, description, quantity, unit_price, discount_percent)
    VALUES (v_lead, v_org, v_biz, 'item B', 1, 200, 10)
    RETURNING id INTO v_item2;

    SELECT line_total INTO v_item1_total FROM public.crm_lead_items WHERE id = v_item1;
    IF v_item1_total <> 100 THEN
      RAISE EXCEPTION 'line_total mismatch on insert: expected 100 got %', v_item1_total;
    END IF;

    SELECT expected_revenue INTO v_rev FROM public.crm_leads WHERE id = v_lead;
    IF v_rev <> 280 THEN
      RAISE EXCEPTION 'expected_revenue after insert: expected 280 (100 + 180) got %', v_rev;
    END IF;

    -- Update qty on item A: 2 -> 3 (line_total: 100 -> 150, total: 280 -> 330)
    UPDATE public.crm_lead_items SET quantity = 3 WHERE id = v_item1;

    SELECT line_total INTO v_item1_total FROM public.crm_lead_items WHERE id = v_item1;
    IF v_item1_total <> 150 THEN
      RAISE EXCEPTION 'line_total mismatch on update: expected 150 got %', v_item1_total;
    END IF;

    SELECT expected_revenue INTO v_rev FROM public.crm_leads WHERE id = v_lead;
    IF v_rev <> 330 THEN
      RAISE EXCEPTION 'expected_revenue after qty update: expected 330 got %', v_rev;
    END IF;

    -- Delete item B -> expected_revenue collapses to item A's 150.
    DELETE FROM public.crm_lead_items WHERE id = v_item2;

    SELECT expected_revenue INTO v_rev FROM public.crm_leads WHERE id = v_lead;
    IF v_rev <> 150 THEN
      RAISE EXCEPTION 'expected_revenue after delete: expected 150 got %', v_rev;
    END IF;

    -- Delete the last item -> trigger leaves expected_revenue untouched
    -- (gated by `v_total > 0` in trg_crm_lead_items_recompute).
    DELETE FROM public.crm_lead_items WHERE id = v_item1;

    SELECT expected_revenue INTO v_rev FROM public.crm_leads WHERE id = v_lead;
    IF v_rev <> 150 THEN
      RAISE EXCEPTION 'expected_revenue clobbered on empty items: expected 150 (preserved) got %', v_rev;
    END IF;
  END $$;
ROLLBACK;