-- ============================================================
-- Label demand coverage completion (Phase 6 item 3)
--
-- Three producers were missing from the demand layer. Each is wired as
-- a server-side trigger on the path that already owns the state change,
-- so demand cannot be forgotten by a client that closed its tab.
-- ============================================================

-- 1. Product creation (import completion + manual creation).
--    A product that has just entered the catalogue has never carried a
--    label. Raising demand on INSERT covers bulk imports without
--    coupling to import batch plumbing, and the open-demand unique
--    constraint collapses repeats.
CREATE OR REPLACE FUNCTION public._label_demand_on_product_created()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.business_id IS NULL THEN RETURN NEW; END IF;
  IF COALESCE(NEW.is_active, true) = false THEN RETURN NEW; END IF;

  PERFORM public.raise_label_demand(
    NEW.business_id, NEW.id, 'product_import'::public.label_demand_reason,
    'product'::public.label_entity_type, NULL, 1, 'product_label', 'product', NEW.id,
    jsonb_build_object('source', 'product_created')
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_label_demand_product_created ON public.products;
CREATE TRIGGER trg_label_demand_product_created
  AFTER INSERT ON public.products
  FOR EACH ROW EXECUTE FUNCTION public._label_demand_on_product_created();

-- 2. Promotion activation.
--    A live promotion changes the shelf edge, not the till alone. Only
--    product-targeted promotions produce demand; category/whole-basket
--    promotions have no per-item label consequence.
CREATE OR REPLACE FUNCTION public._label_demand_on_promotion_active()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_pid uuid; v_biz uuid;
BEGIN
  IF NEW.is_active IS NOT TRUE THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.is_active IS TRUE THEN RETURN NEW; END IF;
  IF NEW.applies_to IS DISTINCT FROM 'product' THEN RETURN NEW; END IF;
  IF NEW.target_ids IS NULL OR array_length(NEW.target_ids, 1) IS NULL THEN RETURN NEW; END IF;
  IF NEW.valid_to IS NOT NULL AND NEW.valid_to < now() THEN RETURN NEW; END IF;

  FOREACH v_pid IN ARRAY NEW.target_ids LOOP
    SELECT p.business_id INTO v_biz FROM public.products p WHERE p.id = v_pid;
    IF v_biz IS NULL THEN CONTINUE; END IF;

    PERFORM public.raise_label_demand(
      v_biz, v_pid, 'promotion'::public.label_demand_reason,
      'product'::public.label_entity_type, NULL, 1, 'shelf_label', 'promotion', NEW.id,
      jsonb_build_object('promotion_name', NEW.name, 'valid_to', NEW.valid_to)
    );
  END LOOP;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_label_demand_promotion_active ON public.promotions;
CREATE TRIGGER trg_label_demand_promotion_active
  AFTER INSERT OR UPDATE OF is_active, target_ids ON public.promotions
  FOR EACH ROW EXECUTE FUNCTION public._label_demand_on_promotion_active();

-- 3. Physical count approval.
--    Variance at count time usually means the shelf could not be read
--    against the record. Demand is raised only for lines that actually
--    varied, so an accurate count produces no label work.
CREATE OR REPLACE FUNCTION public._label_demand_on_count_approved()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record;
BEGIN
  IF NEW.approved_at IS NULL OR OLD.approved_at IS NOT NULL THEN RETURN NEW; END IF;
  IF NEW.business_id IS NULL THEN RETURN NEW; END IF;

  FOR r IN
    SELECT l.product_id, MAX(ABS(COALESCE(l.variance_qty, 0))) AS variance
    FROM public.physical_count_lines l
    WHERE l.count_id = NEW.id
      AND l.product_id IS NOT NULL
      AND COALESCE(l.variance_qty, 0) <> 0
    GROUP BY l.product_id
  LOOP
    PERFORM public.raise_label_demand(
      NEW.business_id, r.product_id, 'recount'::public.label_demand_reason,
      'product'::public.label_entity_type, NEW.branch_id, 1, 'product_label',
      'physical_count', NEW.id,
      jsonb_build_object('variance_qty', r.variance, 'count_number', NEW.count_number)
    );
  END LOOP;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_label_demand_count_approved ON public.physical_counts;
CREATE TRIGGER trg_label_demand_count_approved
  AFTER UPDATE OF approved_at ON public.physical_counts
  FOR EACH ROW EXECUTE FUNCTION public._label_demand_on_count_approved();