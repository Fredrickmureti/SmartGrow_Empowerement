DROP FUNCTION IF EXISTS public.upsert_project_cost(uuid, uuid, uuid, uuid, text, uuid, uuid, numeric, numeric, text, timestamptz, text);

CREATE OR REPLACE FUNCTION public.upsert_project_cost(
  _project_id uuid, _organization_id uuid, _business_id uuid, _task_id uuid,
  _source_type text, _source_id uuid, _employee_id uuid,
  _hours numeric, _amount numeric, _currency text,
  _posted_at timestamptz, _description text, _entry_nature text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_currency text := COALESCE(_currency, 'USD');
  v_posted_at timestamptz := COALESCE(_posted_at, now());
  v_base text;
  v_rate numeric;
  v_nature text := COALESCE(_entry_nature, 'actual');
BEGIN
  IF v_nature NOT IN ('actual','commitment') THEN
    RAISE EXCEPTION 'upsert_project_cost: invalid entry_nature %', v_nature;
  END IF;

  SELECT base_currency INTO v_base FROM public.businesses WHERE id = _business_id;

  IF v_base IS NULL THEN
    v_rate := NULL;
  ELSIF upper(v_currency) = upper(v_base) THEN
    v_rate := 1;
  ELSE
    -- Canonical rate source. Returns NULL when nothing is on file; never invent one.
    v_rate := public.resolve_exchange_rate(_organization_id, _business_id, v_currency, v_posted_at::date);
  END IF;

  INSERT INTO public.project_cost_entries
    (project_id, organization_id, business_id, task_id, source_type, source_id,
     employee_id, hours, amount, currency, posted_at, description,
     entry_nature, fx_rate, base_currency, amount_base)
  VALUES (_project_id, _organization_id, _business_id, _task_id, _source_type, _source_id,
          _employee_id, _hours, _amount, v_currency, v_posted_at, _description,
          v_nature, v_rate, v_base,
          CASE WHEN v_rate IS NULL THEN NULL ELSE COALESCE(_amount,0) * v_rate END)
  ON CONFLICT (source_type, source_id, project_id,
               COALESCE(task_id, '00000000-0000-0000-0000-000000000000'::uuid))
    WHERE source_id IS NOT NULL AND source_type <> 'manual'
  DO UPDATE SET
    organization_id = EXCLUDED.organization_id,
    business_id     = EXCLUDED.business_id,
    employee_id     = EXCLUDED.employee_id,
    hours           = EXCLUDED.hours,
    amount          = EXCLUDED.amount,
    currency        = EXCLUDED.currency,
    posted_at       = EXCLUDED.posted_at,
    description     = EXCLUDED.description,
    entry_nature    = EXCLUDED.entry_nature,
    fx_rate         = EXCLUDED.fx_rate,
    base_currency   = EXCLUDED.base_currency,
    amount_base     = EXCLUDED.amount_base;
END; $function$;

REVOKE ALL ON FUNCTION public.upsert_project_cost(uuid, uuid, uuid, uuid, text, uuid, uuid, numeric, numeric, text, timestamptz, text, text) FROM PUBLIC, anon;

-- ---------------------------------------------------------------- feeders ----
CREATE OR REPLACE FUNCTION public.trg_timesheet_to_cost()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_rate numeric; v_amount numeric;
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM public.project_cost_entries
      WHERE source_type='timesheet' AND source_id = OLD.id;
    RETURN OLD;
  END IF;

  IF NEW.project_id IS NULL OR NEW.status <> 'approved' THEN
    DELETE FROM public.project_cost_entries
      WHERE source_type='timesheet' AND source_id = NEW.id;
    RETURN NEW;
  END IF;

  v_rate   := COALESCE(NEW.cost_rate,
                       public.project_employee_cost_rate(NEW.employee_id, NEW.project_id));
  v_amount := COALESCE(NEW.hours,0) * COALESCE(v_rate,0);

  PERFORM public.upsert_project_cost(
    NEW.project_id, NEW.organization_id, NEW.business_id, NEW.task_id,
    'timesheet', NEW.id, NEW.employee_id,
    NEW.hours, v_amount, NULL, COALESCE(NEW.approved_at, NEW.date::timestamptz),
    'Timesheet labour cost', 'actual'
  );
  RETURN NEW;
END; $function$;

CREATE OR REPLACE FUNCTION public.trg_expense_to_cost()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM public.project_cost_entries
      WHERE source_type='expense' AND source_id = OLD.id;
    RETURN OLD;
  END IF;

  IF NEW.project_id IS NULL OR NEW.status NOT IN ('approved','paid') THEN
    DELETE FROM public.project_cost_entries
      WHERE source_type='expense' AND source_id = NEW.id;
    RETURN NEW;
  END IF;

  PERFORM public.upsert_project_cost(
    NEW.project_id, NEW.organization_id, NEW.business_id, NEW.task_id,
    'expense', NEW.id, NULL,
    NULL, COALESCE(NEW.amount,0), NEW.currency, NEW.created_at,
    'Expense', 'actual'
  );
  RETURN NEW;
END; $function$;

CREATE OR REPLACE FUNCTION public.trg_stock_movement_to_cost()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_amount numeric; v_project_currency text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM public.project_cost_entries
      WHERE source_type='stock_movement' AND source_id = OLD.id;
    RETURN OLD;
  END IF;

  IF NEW.project_id IS NULL OR COALESCE(NEW.quantity,0) >= 0 THEN
    DELETE FROM public.project_cost_entries
      WHERE source_type='stock_movement' AND source_id = NEW.id;
    RETURN NEW;
  END IF;

  v_amount := ABS(NEW.quantity) * COALESCE(NEW.unit_cost, 0);

  SELECT COALESCE(currency,'USD') INTO v_project_currency
    FROM public.projects WHERE id = NEW.project_id;

  PERFORM public.upsert_project_cost(
    NEW.project_id, NEW.organization_id, NEW.business_id, NULL,
    'stock_movement', NEW.id, NULL,
    NULL, v_amount, v_project_currency, NEW.movement_date,
    'Inventory consumed on project', 'actual'
  );
  RETURN NEW;
END; $function$;

CREATE OR REPLACE FUNCTION public.trg_bill_to_cost()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE r record; v_has_line_proj boolean; v_active boolean;
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
    FOR r IN
      SELECT bi.project_id, bi.task_id, SUM(COALESCE(bi.line_total,0)) AS amount
      FROM public.bill_items bi
      WHERE bi.bill_id = NEW.id AND bi.project_id IS NOT NULL
      GROUP BY bi.project_id, bi.task_id
    LOOP
      PERFORM public.upsert_project_cost(
        r.project_id, NEW.organization_id, NEW.business_id, r.task_id,
        'vendor_bill', NEW.id, NULL,
        NULL, r.amount, NEW.currency, NEW.created_at,
        'Vendor bill (line-tagged)', 'actual'
      );
    END LOOP;
    RETURN NEW;
  END IF;

  IF NEW.project_id IS NOT NULL THEN
    PERFORM public.upsert_project_cost(
      NEW.project_id, NEW.organization_id, NEW.business_id, NEW.task_id,
      'vendor_bill', NEW.id, NULL,
      NULL, COALESCE(NEW.total, NEW.subtotal, 0), NEW.currency, NEW.created_at,
      'Vendor bill', 'actual'
    );
  END IF;
  RETURN NEW;
END; $function$;

CREATE OR REPLACE FUNCTION public.trg_purchase_order_to_cost()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE r record; v_has_line_proj boolean; v_active boolean;
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
    FOR r IN
      SELECT poi.project_id, poi.task_id, SUM(COALESCE(poi.line_total,0)) AS amount
      FROM public.purchase_order_items poi
      WHERE poi.purchase_order_id = NEW.id AND poi.project_id IS NOT NULL
      GROUP BY poi.project_id, poi.task_id
    LOOP
      PERFORM public.upsert_project_cost(
        r.project_id, NEW.organization_id, NEW.business_id, r.task_id,
        'purchase_order', NEW.id, NULL,
        NULL, r.amount, NEW.currency, NEW.created_at,
        'Purchase order (commitment, line-tagged)', 'commitment'
      );
    END LOOP;
    RETURN NEW;
  END IF;

  IF NEW.project_id IS NOT NULL THEN
    PERFORM public.upsert_project_cost(
      NEW.project_id, NEW.organization_id, NEW.business_id, NULL,
      'purchase_order', NEW.id, NULL,
      NULL, COALESCE(NEW.total, NEW.subtotal, 0), NEW.currency, NEW.created_at,
      'Purchase order (commitment)', 'commitment'
    );
  END IF;
  RETURN NEW;
END; $function$;