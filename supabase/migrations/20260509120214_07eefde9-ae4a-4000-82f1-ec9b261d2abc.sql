
-- 1. Add per-line project/task to bill_items (parity with invoice_items / sales_order_items / purchase_order_items)
ALTER TABLE public.bill_items
  ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES public.projects(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS task_id    uuid REFERENCES public.project_tasks(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_bill_items_project ON public.bill_items(project_id) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bill_items_task    ON public.bill_items(task_id)    WHERE task_id    IS NOT NULL;

-- 2. Generic helper: post analytic entries for one source document by line groups.
--    Uses the existing upsert_project_cost / upsert_project_revenue helpers so the
--    accounting truth keeps living in those two functions.

-- 2a. INVOICE (revenue)
CREATE OR REPLACE FUNCTION public.trg_invoice_to_revenue()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_has_line_proj boolean;
  v_active boolean;
  v_proj_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM public.project_revenue_entries
      WHERE source_type='invoice' AND source_id = OLD.id;
    RETURN OLD;
  END IF;

  v_active := NEW.status::text IN ('sent','viewed','partial','paid','confirmed','overdue');

  -- Always purge previous entries for this invoice; we'll re-emit below.
  DELETE FROM public.project_revenue_entries
    WHERE source_type='invoice' AND source_id = NEW.id;

  IF NOT v_active THEN
    RETURN NEW;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.invoice_items WHERE invoice_id = NEW.id AND project_id IS NOT NULL
  ) INTO v_has_line_proj;

  IF v_has_line_proj THEN
    -- Per-line aggregation by (project_id) — invoices don't carry task on revenue.
    INSERT INTO public.project_revenue_entries
      (project_id, organization_id, business_id, source_type, source_id,
       milestone_id, amount, currency, posted_at, description)
    SELECT
      ii.project_id,
      NEW.organization_id,
      NEW.business_id,
      'invoice',
      NEW.id,
      NULL,
      SUM(COALESCE(ii.line_total,0)),
      NEW.currency,
      NEW.created_at,
      'Customer invoice (line-tagged)'
    FROM public.invoice_items ii
    WHERE ii.invoice_id = NEW.id
      AND ii.project_id IS NOT NULL
    GROUP BY ii.project_id;
    RETURN NEW;
  END IF;

  -- Header fallback (legacy behavior)
  IF NEW.project_id IS NOT NULL THEN
    PERFORM public.upsert_project_revenue(
      NEW.project_id, NEW.organization_id, NEW.business_id,
      'invoice', NEW.id, NULL,
      COALESCE(NEW.total, NEW.subtotal, 0), NEW.currency, NEW.created_at,
      'Customer invoice'
    );
  END IF;
  RETURN NEW;
END; $$;

-- 2b. SALES ORDER (revenue) — was missing line-aware logic
CREATE OR REPLACE FUNCTION public.trg_sales_order_to_revenue()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_has_line_proj boolean;
  v_active boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM public.project_revenue_entries
      WHERE source_type='sales_order' AND source_id = OLD.id;
    RETURN OLD;
  END IF;

  v_active := NEW.status::text IN ('confirmed','partial','delivered','done','invoiced');

  DELETE FROM public.project_revenue_entries
    WHERE source_type='sales_order' AND source_id = NEW.id;

  IF NOT v_active THEN
    RETURN NEW;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.sales_order_items WHERE sales_order_id = NEW.id AND project_id IS NOT NULL
  ) INTO v_has_line_proj;

  IF v_has_line_proj THEN
    INSERT INTO public.project_revenue_entries
      (project_id, organization_id, business_id, source_type, source_id,
       milestone_id, amount, currency, posted_at, description)
    SELECT
      soi.project_id,
      NEW.organization_id,
      NEW.business_id,
      'sales_order',
      NEW.id,
      NULL,
      SUM(COALESCE(soi.line_total,0)),
      NEW.currency,
      NEW.created_at,
      'Sales order (line-tagged)'
    FROM public.sales_order_items soi
    WHERE soi.sales_order_id = NEW.id
      AND soi.project_id IS NOT NULL
    GROUP BY soi.project_id;
    RETURN NEW;
  END IF;

  IF NEW.project_id IS NOT NULL THEN
    PERFORM public.upsert_project_revenue(
      NEW.project_id, NEW.organization_id, NEW.business_id,
      'sales_order', NEW.id, NULL,
      COALESCE(NEW.total, NEW.subtotal, 0), NEW.currency, NEW.created_at,
      'Sales order (commitment)'
    );
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_sales_orders_revenue ON public.sales_orders;
CREATE TRIGGER trg_sales_orders_revenue
  AFTER INSERT OR UPDATE OR DELETE ON public.sales_orders
  FOR EACH ROW EXECUTE FUNCTION public.trg_sales_order_to_revenue();

-- 2c. PURCHASE ORDER (cost commitment) — was missing line-aware logic
CREATE OR REPLACE FUNCTION public.trg_purchase_order_to_cost()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_has_line_proj boolean;
  v_active boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM public.project_cost_entries
      WHERE source_type='purchase_order' AND source_id = OLD.id;
    RETURN OLD;
  END IF;

  v_active := NEW.status::text IN ('confirmed','received','partial','done');

  DELETE FROM public.project_cost_entries
    WHERE source_type='purchase_order' AND source_id = NEW.id;

  IF NOT v_active THEN
    RETURN NEW;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.purchase_order_items WHERE purchase_order_id = NEW.id AND project_id IS NOT NULL
  ) INTO v_has_line_proj;

  IF v_has_line_proj THEN
    INSERT INTO public.project_cost_entries
      (project_id, organization_id, business_id, task_id,
       source_type, source_id, employee_id,
       hours, amount, currency, posted_at, description)
    SELECT
      poi.project_id,
      NEW.organization_id,
      NEW.business_id,
      poi.task_id,
      'purchase_order',
      NEW.id,
      NULL,
      NULL,
      SUM(COALESCE(poi.line_total,0)),
      NEW.currency,
      NEW.created_at,
      'Purchase order (line-tagged)'
    FROM public.purchase_order_items poi
    WHERE poi.purchase_order_id = NEW.id
      AND poi.project_id IS NOT NULL
    GROUP BY poi.project_id, poi.task_id;
    RETURN NEW;
  END IF;

  IF NEW.project_id IS NOT NULL THEN
    PERFORM public.upsert_project_cost(
      NEW.project_id, NEW.organization_id, NEW.business_id, NULL,
      'purchase_order', NEW.id, NULL,
      NULL, COALESCE(NEW.total, NEW.subtotal, 0), NEW.currency, NEW.created_at,
      'Purchase order (commitment)'
    );
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_purchase_orders_cost ON public.purchase_orders;
CREATE TRIGGER trg_purchase_orders_cost
  AFTER INSERT OR UPDATE OR DELETE ON public.purchase_orders
  FOR EACH ROW EXECUTE FUNCTION public.trg_purchase_order_to_cost();

-- 2d. BILL (cost) — line-aware
CREATE OR REPLACE FUNCTION public.trg_bill_to_cost()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_has_line_proj boolean;
  v_active boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM public.project_cost_entries
      WHERE source_type='vendor_bill' AND source_id = OLD.id;
    RETURN OLD;
  END IF;

  v_active := NEW.status::text IN ('received','partial','paid','overdue');

  DELETE FROM public.project_cost_entries
    WHERE source_type='vendor_bill' AND source_id = NEW.id;

  IF NOT v_active THEN
    RETURN NEW;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.bill_items WHERE bill_id = NEW.id AND project_id IS NOT NULL
  ) INTO v_has_line_proj;

  IF v_has_line_proj THEN
    INSERT INTO public.project_cost_entries
      (project_id, organization_id, business_id, task_id,
       source_type, source_id, employee_id,
       hours, amount, currency, posted_at, description)
    SELECT
      bi.project_id,
      NEW.organization_id,
      NEW.business_id,
      bi.task_id,
      'vendor_bill',
      NEW.id,
      NULL,
      NULL,
      SUM(COALESCE(bi.line_total,0)),
      NEW.currency,
      NEW.created_at,
      'Vendor bill (line-tagged)'
    FROM public.bill_items bi
    WHERE bi.bill_id = NEW.id
      AND bi.project_id IS NOT NULL
    GROUP BY bi.project_id, bi.task_id;
    RETURN NEW;
  END IF;

  IF NEW.project_id IS NOT NULL THEN
    PERFORM public.upsert_project_cost(
      NEW.project_id, NEW.organization_id, NEW.business_id, NEW.task_id,
      'vendor_bill', NEW.id, NULL,
      NULL, COALESCE(NEW.total, NEW.subtotal, 0), NEW.currency, NEW.created_at,
      'Vendor bill'
    );
  END IF;
  RETURN NEW;
END; $$;

-- 3. Repost when LINES change (so editing line projects refreshes analytics
--    even if the document header doesn't change).
CREATE OR REPLACE FUNCTION public.trg_invoice_lines_repost_revenue()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid; r record;
BEGIN
  v_id := COALESCE(NEW.invoice_id, OLD.invoice_id);
  IF v_id IS NULL THEN RETURN COALESCE(NEW, OLD); END IF;
  SELECT * INTO r FROM public.invoices WHERE id = v_id;
  IF FOUND THEN
    PERFORM public.trg_invoice_to_revenue() FROM (SELECT 1) s; -- ensure function exists
    -- Re-run by issuing a no-op UPDATE which fires the AFTER trigger
    UPDATE public.invoices SET updated_at = COALESCE(updated_at, now()) WHERE id = v_id;
  END IF;
  RETURN COALESCE(NEW, OLD);
END; $$;
DROP TRIGGER IF EXISTS trg_invoice_items_repost ON public.invoice_items;
CREATE TRIGGER trg_invoice_items_repost
  AFTER INSERT OR UPDATE OR DELETE ON public.invoice_items
  FOR EACH ROW EXECUTE FUNCTION public.trg_invoice_lines_repost_revenue();

CREATE OR REPLACE FUNCTION public.trg_so_lines_repost_revenue()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid;
BEGIN
  v_id := COALESCE(NEW.sales_order_id, OLD.sales_order_id);
  IF v_id IS NOT NULL THEN
    UPDATE public.sales_orders SET updated_at = COALESCE(updated_at, now()) WHERE id = v_id;
  END IF;
  RETURN COALESCE(NEW, OLD);
END; $$;
DROP TRIGGER IF EXISTS trg_sales_order_items_repost ON public.sales_order_items;
CREATE TRIGGER trg_sales_order_items_repost
  AFTER INSERT OR UPDATE OR DELETE ON public.sales_order_items
  FOR EACH ROW EXECUTE FUNCTION public.trg_so_lines_repost_revenue();

CREATE OR REPLACE FUNCTION public.trg_po_lines_repost_cost()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid;
BEGIN
  v_id := COALESCE(NEW.purchase_order_id, OLD.purchase_order_id);
  IF v_id IS NOT NULL THEN
    UPDATE public.purchase_orders SET updated_at = COALESCE(updated_at, now()) WHERE id = v_id;
  END IF;
  RETURN COALESCE(NEW, OLD);
END; $$;
DROP TRIGGER IF EXISTS trg_purchase_order_items_repost ON public.purchase_order_items;
CREATE TRIGGER trg_purchase_order_items_repost
  AFTER INSERT OR UPDATE OR DELETE ON public.purchase_order_items
  FOR EACH ROW EXECUTE FUNCTION public.trg_po_lines_repost_cost();

CREATE OR REPLACE FUNCTION public.trg_bill_lines_repost_cost()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid;
BEGIN
  v_id := COALESCE(NEW.bill_id, OLD.bill_id);
  IF v_id IS NOT NULL THEN
    UPDATE public.bills SET updated_at = COALESCE(updated_at, now()) WHERE id = v_id;
  END IF;
  RETURN COALESCE(NEW, OLD);
END; $$;
DROP TRIGGER IF EXISTS trg_bill_items_repost ON public.bill_items;
CREATE TRIGGER trg_bill_items_repost
  AFTER INSERT OR UPDATE OR DELETE ON public.bill_items
  FOR EACH ROW EXECUTE FUNCTION public.trg_bill_lines_repost_cost();
