DROP FUNCTION IF EXISTS public.upsert_project_revenue(uuid, uuid, uuid, text, uuid, uuid, numeric, text, timestamptz, text);

CREATE OR REPLACE FUNCTION public.upsert_project_revenue(
  _project_id uuid, _organization_id uuid, _business_id uuid,
  _source_type text, _source_id uuid, _milestone_id uuid,
  _amount numeric, _currency text, _posted_at timestamptz, _description text,
  _entry_nature text
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
    RAISE EXCEPTION 'upsert_project_revenue: invalid entry_nature %', v_nature;
  END IF;

  SELECT base_currency INTO v_base FROM public.businesses WHERE id = _business_id;

  IF v_base IS NULL THEN
    v_rate := NULL;
  ELSIF upper(v_currency) = upper(v_base) THEN
    v_rate := 1;
  ELSE
    v_rate := public.resolve_exchange_rate(_organization_id, _business_id, v_currency, v_posted_at::date);
  END IF;

  INSERT INTO public.project_revenue_entries
    (project_id, organization_id, business_id, source_type, source_id, milestone_id,
     amount, currency, posted_at, description,
     entry_nature, fx_rate, base_currency, amount_base)
  VALUES (_project_id, _organization_id, _business_id, _source_type, _source_id, _milestone_id,
          _amount, v_currency, v_posted_at, _description,
          v_nature, v_rate, v_base,
          CASE WHEN v_rate IS NULL THEN NULL ELSE COALESCE(_amount,0) * v_rate END)
  ON CONFLICT (source_type, source_id, project_id,
               COALESCE(milestone_id, '00000000-0000-0000-0000-000000000000'::uuid))
    WHERE source_id IS NOT NULL AND source_type <> 'manual'
  DO UPDATE SET
    organization_id = EXCLUDED.organization_id,
    business_id     = EXCLUDED.business_id,
    amount          = EXCLUDED.amount,
    currency        = EXCLUDED.currency,
    posted_at       = EXCLUDED.posted_at,
    description     = EXCLUDED.description,
    entry_nature    = EXCLUDED.entry_nature,
    fx_rate         = EXCLUDED.fx_rate,
    base_currency   = EXCLUDED.base_currency,
    amount_base     = EXCLUDED.amount_base;
END; $function$;

REVOKE ALL ON FUNCTION public.upsert_project_revenue(uuid, uuid, uuid, text, uuid, uuid, numeric, text, timestamptz, text, text) FROM PUBLIC, anon;

-- ---------------------------------------------------------------- feeders ----
CREATE OR REPLACE FUNCTION public.trg_invoice_to_revenue()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE r record; v_has_line_proj boolean; v_active boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM public.project_revenue_entries
      WHERE source_type='invoice' AND source_id = OLD.id;
    RETURN OLD;
  END IF;

  v_active := NEW.status::text IN ('sent','viewed','partial','paid','confirmed','overdue');

  DELETE FROM public.project_revenue_entries
    WHERE source_type='invoice' AND source_id = NEW.id;

  IF NOT v_active THEN
    RETURN NEW;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.invoice_items WHERE invoice_id = NEW.id AND project_id IS NOT NULL
  ) INTO v_has_line_proj;

  IF v_has_line_proj THEN
    FOR r IN
      SELECT ii.project_id, SUM(COALESCE(ii.line_total,0)) AS amount
      FROM public.invoice_items ii
      WHERE ii.invoice_id = NEW.id AND ii.project_id IS NOT NULL
      GROUP BY ii.project_id
    LOOP
      PERFORM public.upsert_project_revenue(
        r.project_id, NEW.organization_id, NEW.business_id,
        'invoice', NEW.id, NULL,
        r.amount, NEW.currency, NEW.created_at,
        'Customer invoice (line-tagged)', 'actual'
      );
    END LOOP;
    RETURN NEW;
  END IF;

  IF NEW.project_id IS NOT NULL THEN
    PERFORM public.upsert_project_revenue(
      NEW.project_id, NEW.organization_id, NEW.business_id,
      'invoice', NEW.id, NULL,
      COALESCE(NEW.total, NEW.subtotal, 0), NEW.currency, NEW.created_at,
      'Customer invoice', 'actual'
    );
  END IF;
  RETURN NEW;
END; $function$;

CREATE OR REPLACE FUNCTION public.trg_sales_order_to_revenue()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE r record; v_has_line_proj boolean; v_active boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM public.project_revenue_entries
      WHERE source_type='sales_order' AND source_id = OLD.id;
    RETURN OLD;
  END IF;

  -- Forecast only. Realized revenue is owned by the invoice trigger; these rows
  -- are entry_nature='commitment' and never enter margin.
  v_active := NEW.status::text IN ('confirmed','processing','partial','fulfilled');

  DELETE FROM public.project_revenue_entries
    WHERE source_type='sales_order' AND source_id = NEW.id;

  IF NOT v_active THEN
    RETURN NEW;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.sales_order_items
     WHERE sales_order_id = NEW.id AND project_id IS NOT NULL
  ) INTO v_has_line_proj;

  IF v_has_line_proj THEN
    FOR r IN
      SELECT soi.project_id, SUM(COALESCE(soi.line_total,0)) AS amount
      FROM public.sales_order_items soi
      WHERE soi.sales_order_id = NEW.id AND soi.project_id IS NOT NULL
      GROUP BY soi.project_id
    LOOP
      PERFORM public.upsert_project_revenue(
        r.project_id, NEW.organization_id, NEW.business_id,
        'sales_order', NEW.id, NULL,
        r.amount, NEW.currency, NEW.created_at,
        'Sales order (forecast, line-tagged)', 'commitment'
      );
    END LOOP;
    RETURN NEW;
  END IF;

  IF NEW.project_id IS NOT NULL THEN
    PERFORM public.upsert_project_revenue(
      NEW.project_id, NEW.organization_id, NEW.business_id,
      'sales_order', NEW.id, NULL,
      COALESCE(NEW.total, NEW.subtotal, 0), NEW.currency, NEW.created_at,
      'Sales order (forecast)', 'commitment'
    );
  END IF;
  RETURN NEW;
END; $function$;

CREATE OR REPLACE FUNCTION public.trg_milestone_to_revenue()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_proj public.projects%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM public.project_revenue_entries
      WHERE source_type='milestone' AND source_id = OLD.id;
    RETURN OLD;
  END IF;

  SELECT * INTO v_proj FROM public.projects WHERE id = NEW.project_id;
  IF v_proj.id IS NULL OR v_proj.pricing_type <> 'milestone'
     OR NEW.is_reached IS NOT TRUE OR COALESCE(NEW.billing_amount,0) = 0 THEN
    DELETE FROM public.project_revenue_entries
      WHERE source_type='milestone' AND source_id = NEW.id;
    RETURN NEW;
  END IF;

  PERFORM public.upsert_project_revenue(
    v_proj.id, v_proj.organization_id, v_proj.business_id,
    'milestone', NEW.id, NEW.id,
    NEW.billing_amount, v_proj.currency, COALESCE(NEW.reached_at, now()),
    'Milestone billed: ' || NEW.name, 'actual'
  );
  RETURN NEW;
END; $function$;