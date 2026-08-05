-- ============================================================
-- Label Operations Engine — demand, runs, server-side expansion
-- ============================================================

CREATE TYPE public.label_entity_type AS ENUM ('product','location','lot','carton','pallet');
CREATE TYPE public.label_demand_reason AS ENUM ('goods_receipt','price_change','barcode_enrolled','product_import','promotion','recount','manual');
CREATE TYPE public.label_demand_status AS ENUM ('open','queued','dismissed');
CREATE TYPE public.label_run_status AS ENUM ('draft','expanding','running','paused','completed','failed','cancelled');
CREATE TYPE public.label_run_line_status AS ENUM ('pending','queued','printed','failed','refused');

-- ---------------- label_demand ----------------
CREATE TABLE public.label_demand (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  branch_id uuid,
  entity_type public.label_entity_type NOT NULL DEFAULT 'product',
  entity_id uuid NOT NULL,
  reason public.label_demand_reason NOT NULL,
  suggested_template_key text,
  qty_hint integer NOT NULL DEFAULT 1,
  status public.label_demand_status NOT NULL DEFAULT 'open',
  source_doc_type text,
  source_doc_id uuid,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX label_demand_open_uniq
  ON public.label_demand (business_id, entity_type, entity_id, reason)
  WHERE status = 'open';
CREATE INDEX label_demand_business_status_idx ON public.label_demand (business_id, status, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.label_demand TO authenticated;
GRANT ALL ON public.label_demand TO service_role;
ALTER TABLE public.label_demand ENABLE ROW LEVEL SECURITY;

CREATE POLICY label_demand_rw ON public.label_demand
  FOR ALL TO authenticated
  USING (public.user_has_business_access(auth.uid(), business_id))
  WITH CHECK (public.user_has_business_access(auth.uid(), business_id));

-- ---------------- label_print_runs ----------------
CREATE TABLE public.label_print_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  branch_id uuid,
  warehouse_id uuid,
  name text,
  entity_type public.label_entity_type NOT NULL DEFAULT 'product',
  template_key text NOT NULL,
  workflow text NOT NULL DEFAULT 'product_tag',
  copies smallint NOT NULL DEFAULT 1,
  selection_spec jsonb NOT NULL DEFAULT '{}'::jsonb,
  status public.label_run_status NOT NULL DEFAULT 'expanding',
  expansion_complete boolean NOT NULL DEFAULT false,
  total_lines integer NOT NULL DEFAULT 0,
  queued_lines integer NOT NULL DEFAULT 0,
  printed_lines integer NOT NULL DEFAULT 0,
  failed_lines integer NOT NULL DEFAULT 0,
  refused_lines integer NOT NULL DEFAULT 0,
  last_error text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX label_print_runs_business_idx ON public.label_print_runs (business_id, created_at DESC);
CREATE INDEX label_print_runs_active_idx ON public.label_print_runs (status) WHERE status IN ('expanding','running');

GRANT SELECT, INSERT, UPDATE, DELETE ON public.label_print_runs TO authenticated;
GRANT ALL ON public.label_print_runs TO service_role;
ALTER TABLE public.label_print_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY label_print_runs_rw ON public.label_print_runs
  FOR ALL TO authenticated
  USING (public.user_has_business_access(auth.uid(), business_id))
  WITH CHECK (public.user_has_business_access(auth.uid(), business_id));

-- ---------------- label_print_run_lines ----------------
CREATE TABLE public.label_print_run_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.label_print_runs(id) ON DELETE CASCADE,
  business_id uuid NOT NULL,
  entity_type public.label_entity_type NOT NULL,
  entity_id uuid NOT NULL,
  entity_label text,
  copies smallint NOT NULL DEFAULT 1,
  resolved_vars jsonb NOT NULL DEFAULT '{}'::jsonb,
  status public.label_run_line_status NOT NULL DEFAULT 'pending',
  print_job_id uuid,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX label_run_lines_uniq ON public.label_print_run_lines (run_id, entity_id);
CREATE INDEX label_run_lines_run_status_idx ON public.label_print_run_lines (run_id, status);
CREATE INDEX label_run_lines_job_idx ON public.label_print_run_lines (print_job_id) WHERE print_job_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.label_print_run_lines TO authenticated;
GRANT ALL ON public.label_print_run_lines TO service_role;
ALTER TABLE public.label_print_run_lines ENABLE ROW LEVEL SECURITY;

CREATE POLICY label_run_lines_rw ON public.label_print_run_lines
  FOR ALL TO authenticated
  USING (public.user_has_business_access(auth.uid(), business_id))
  WITH CHECK (public.user_has_business_access(auth.uid(), business_id));

-- ---------------- updated_at triggers ----------------
CREATE OR REPLACE FUNCTION public._label_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

CREATE TRIGGER trg_label_demand_touch BEFORE UPDATE ON public.label_demand
  FOR EACH ROW EXECUTE FUNCTION public._label_touch_updated_at();
CREATE TRIGGER trg_label_runs_touch BEFORE UPDATE ON public.label_print_runs
  FOR EACH ROW EXECUTE FUNCTION public._label_touch_updated_at();
CREATE TRIGGER trg_label_run_lines_touch BEFORE UPDATE ON public.label_print_run_lines
  FOR EACH ROW EXECUTE FUNCTION public._label_touch_updated_at();

-- ============================================================
-- Demand raising
-- ============================================================
CREATE OR REPLACE FUNCTION public.raise_label_demand(
  p_business_id uuid,
  p_entity_id uuid,
  p_reason public.label_demand_reason,
  p_entity_type public.label_entity_type DEFAULT 'product',
  p_branch_id uuid DEFAULT NULL,
  p_qty_hint integer DEFAULT 1,
  p_suggested_template_key text DEFAULT NULL,
  p_source_doc_type text DEFAULT NULL,
  p_source_doc_id uuid DEFAULT NULL,
  p_detail jsonb DEFAULT '{}'::jsonb
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_org uuid; v_id uuid;
BEGIN
  SELECT organization_id INTO v_org FROM public.businesses WHERE id = p_business_id;
  IF v_org IS NULL THEN RETURN NULL; END IF;

  INSERT INTO public.label_demand (
    organization_id, business_id, branch_id, entity_type, entity_id, reason,
    suggested_template_key, qty_hint, source_doc_type, source_doc_id, detail, created_by
  ) VALUES (
    v_org, p_business_id, p_branch_id, p_entity_type, p_entity_id, p_reason,
    p_suggested_template_key, GREATEST(1, COALESCE(p_qty_hint, 1)),
    p_source_doc_type, p_source_doc_id, COALESCE(p_detail, '{}'::jsonb), auth.uid()
  )
  ON CONFLICT (business_id, entity_type, entity_id, reason) WHERE status = 'open'
  DO UPDATE SET qty_hint = GREATEST(public.label_demand.qty_hint, EXCLUDED.qty_hint),
                updated_at = now()
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.raise_label_demand(uuid,uuid,public.label_demand_reason,public.label_entity_type,uuid,integer,text,text,uuid,jsonb) TO authenticated, service_role;

-- price change -> demand
CREATE OR REPLACE FUNCTION public._label_demand_on_price_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.business_id IS NULL THEN RETURN NEW; END IF;
  IF COALESCE(NEW.unit_price, -1) IS DISTINCT FROM COALESCE(OLD.unit_price, -1) THEN
    PERFORM public.raise_label_demand(
      NEW.business_id, NEW.id, 'price_change'::public.label_demand_reason,
      'product'::public.label_entity_type, NULL, 1, 'shelf_label', 'product', NEW.id,
      jsonb_build_object('old_price', OLD.unit_price, 'new_price', NEW.unit_price)
    );
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_label_demand_price_change
  AFTER UPDATE OF unit_price ON public.products
  FOR EACH ROW EXECUTE FUNCTION public._label_demand_on_price_change();

-- barcode enrolled -> demand
CREATE OR REPLACE FUNCTION public._label_demand_on_identifier()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.business_id IS NULL OR NEW.status <> 'active' THEN RETURN NEW; END IF;
  PERFORM public.raise_label_demand(
    NEW.business_id, NEW.product_id, 'barcode_enrolled'::public.label_demand_reason,
    'product'::public.label_entity_type, NULL, 1, 'product_label', 'product_identifier', NEW.id,
    jsonb_build_object('code', NEW.code)
  );
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_label_demand_identifier
  AFTER INSERT ON public.product_identifiers
  FOR EACH ROW EXECUTE FUNCTION public._label_demand_on_identifier();

-- goods receipt -> demand
CREATE OR REPLACE FUNCTION public._label_demand_on_receipt_item()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_biz uuid; v_branch uuid;
BEGIN
  IF NEW.product_id IS NULL THEN RETURN NEW; END IF;
  SELECT gr.business_id, COALESCE(NEW.branch_id, gr.branch_id) INTO v_biz, v_branch
  FROM public.goods_receipts gr WHERE gr.id = NEW.goods_receipt_id;
  IF v_biz IS NULL THEN RETURN NEW; END IF;
  PERFORM public.raise_label_demand(
    v_biz, NEW.product_id, 'goods_receipt'::public.label_demand_reason,
    'product'::public.label_entity_type, v_branch,
    GREATEST(1, CEIL(COALESCE(NEW.quantity_received, 0))::int),
    'product_label', 'goods_receipt', NEW.goods_receipt_id, '{}'::jsonb
  );
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_label_demand_receipt_item
  AFTER INSERT ON public.goods_receipt_items
  FOR EACH ROW EXECUTE FUNCTION public._label_demand_on_receipt_item();

-- ============================================================
-- Run creation
-- ============================================================
CREATE OR REPLACE FUNCTION public.create_label_run(
  p_business_id uuid,
  p_template_key text,
  p_workflow text,
  p_selection_spec jsonb,
  p_entity_type public.label_entity_type DEFAULT 'product',
  p_branch_id uuid DEFAULT NULL,
  p_warehouse_id uuid DEFAULT NULL,
  p_copies smallint DEFAULT 1,
  p_name text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_org uuid; v_id uuid;
BEGIN
  IF NOT public.user_has_business_access(auth.uid(), p_business_id) THEN
    RAISE EXCEPTION 'create_label_run: no access to business %', p_business_id USING ERRCODE = '42501';
  END IF;
  SELECT organization_id INTO v_org FROM public.businesses WHERE id = p_business_id;

  INSERT INTO public.label_print_runs (
    organization_id, business_id, branch_id, warehouse_id, name, entity_type,
    template_key, workflow, copies, selection_spec, status, created_by
  ) VALUES (
    v_org, p_business_id, p_branch_id, p_warehouse_id, p_name, p_entity_type,
    p_template_key, COALESCE(p_workflow,'product_tag'), GREATEST(1, COALESCE(p_copies,1::smallint)),
    COALESCE(p_selection_spec,'{}'::jsonb), 'expanding', auth.uid()
  ) RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;
GRANT EXECUTE ON FUNCTION public.create_label_run(uuid,text,text,jsonb,public.label_entity_type,uuid,uuid,smallint,text) TO authenticated, service_role;

-- ============================================================
-- Server-side expansion + enqueue
-- ============================================================
CREATE OR REPLACE FUNCTION public.expand_label_run(
  p_run_id uuid,
  p_batch_size integer DEFAULT 500
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r public.label_print_runs%ROWTYPE;
  v_spec jsonb;
  v_kind text;
  v_inserted integer := 0;
  v_queued integer := 0;
  v_engine text;
  v_media uuid;
  v_batch integer := LEAST(GREATEST(COALESCE(p_batch_size,500),1), 2000);
BEGIN
  SELECT * INTO r FROM public.label_print_runs WHERE id = p_run_id FOR UPDATE;
  IF r.id IS NULL THEN RETURN jsonb_build_object('error','run_not_found'); END IF;
  IF r.status NOT IN ('expanding','running') THEN
    RETURN jsonb_build_object('status', r.status::text, 'skipped', true);
  END IF;

  v_spec := COALESCE(r.selection_spec, '{}'::jsonb);
  v_kind := COALESCE(v_spec->>'kind', 'product_ids');

  -- resolve engine / media once per pass
  SELECT lt.engine::text, lt.media_profile_id INTO v_engine, v_media
  FROM public.label_templates lt
  WHERE lt.org_id = r.organization_id
    AND lt.template_key = r.template_key
    AND lt.active
  ORDER BY (lt.branch_id = r.branch_id) DESC NULLS LAST, lt.version DESC
  LIMIT 1;
  v_engine := COALESCE(v_engine, 'zpl');

  ------------------------------------------------------------------
  -- 1. Expand selection into lines (bounded)
  ------------------------------------------------------------------
  IF NOT r.expansion_complete THEN
    IF v_kind = 'product_ids' THEN
      WITH src AS (
        SELECT p.id, p.name, p.sku, p.unit_price
        FROM public.products p
        WHERE p.business_id = r.business_id
          AND p.id = ANY (SELECT (jsonb_array_elements_text(v_spec->'ids'))::uuid)
          AND NOT EXISTS (SELECT 1 FROM public.label_print_run_lines l WHERE l.run_id = r.id AND l.entity_id = p.id)
        ORDER BY p.id
        LIMIT v_batch
      )
      INSERT INTO public.label_print_run_lines (run_id, business_id, entity_type, entity_id, entity_label, copies, resolved_vars, status)
      SELECT r.id, r.business_id, 'product', s.id, s.name, r.copies,
             public.label_vars_for_product(r.business_id, s.id),
             'pending'
      FROM src s;
      GET DIAGNOSTICS v_inserted = ROW_COUNT;

    ELSIF v_kind = 'product_filter' THEN
      WITH src AS (
        SELECT p.id, p.name
        FROM public.products p
        WHERE p.business_id = r.business_id
          AND (COALESCE((v_spec->>'is_active')::boolean, true) IS NOT TRUE OR p.is_active)
          AND (v_spec->>'category_id' IS NULL OR p.category_id = (v_spec->>'category_id')::uuid)
          AND (v_spec->>'search' IS NULL OR p.name ILIKE '%'||(v_spec->>'search')||'%' OR p.sku ILIKE '%'||(v_spec->>'search')||'%')
          AND (COALESCE((v_spec->>'only_with_barcode')::boolean, false) IS NOT TRUE
               OR EXISTS (SELECT 1 FROM public.product_identifiers pi
                          WHERE pi.product_id = p.id AND pi.status = 'active'))
          AND NOT EXISTS (SELECT 1 FROM public.label_print_run_lines l WHERE l.run_id = r.id AND l.entity_id = p.id)
        ORDER BY p.id
        LIMIT v_batch
      )
      INSERT INTO public.label_print_run_lines (run_id, business_id, entity_type, entity_id, entity_label, copies, resolved_vars, status)
      SELECT r.id, r.business_id, 'product', s.id, s.name, r.copies,
             public.label_vars_for_product(r.business_id, s.id), 'pending'
      FROM src s;
      GET DIAGNOSTICS v_inserted = ROW_COUNT;

    ELSIF v_kind = 'demand' THEN
      WITH src AS (
        SELECT d.id AS demand_id, d.entity_id, d.qty_hint
        FROM public.label_demand d
        WHERE d.business_id = r.business_id
          AND d.status = 'open'
          AND d.entity_type = r.entity_type
          AND (v_spec->>'reason' IS NULL OR d.reason::text = v_spec->>'reason')
          AND NOT EXISTS (SELECT 1 FROM public.label_print_run_lines l WHERE l.run_id = r.id AND l.entity_id = d.entity_id)
        ORDER BY d.entity_id
        LIMIT v_batch
      ), ins AS (
        INSERT INTO public.label_print_run_lines (run_id, business_id, entity_type, entity_id, entity_label, copies, resolved_vars, status)
        SELECT r.id, r.business_id, r.entity_type, s.entity_id, NULL,
               LEAST(GREATEST(s.qty_hint,1), 999)::smallint,
               CASE WHEN r.entity_type = 'product'
                    THEN public.label_vars_for_product(r.business_id, s.entity_id)
                    ELSE public.label_vars_for_location(r.business_id, s.entity_id) END,
               'pending'
        FROM src s
        ON CONFLICT (run_id, entity_id) DO NOTHING
        RETURNING entity_id
      )
      UPDATE public.label_demand d SET status = 'queued'
      WHERE d.id IN (SELECT demand_id FROM src);
      GET DIAGNOSTICS v_inserted = ROW_COUNT;

    ELSIF v_kind = 'location_ids' THEN
      WITH src AS (
        SELECT sl.id, sl.name
        FROM public.stock_locations sl
        WHERE sl.business_id = r.business_id
          AND sl.id = ANY (SELECT (jsonb_array_elements_text(v_spec->'ids'))::uuid)
          AND NOT EXISTS (SELECT 1 FROM public.label_print_run_lines l WHERE l.run_id = r.id AND l.entity_id = sl.id)
        ORDER BY sl.id
        LIMIT v_batch
      )
      INSERT INTO public.label_print_run_lines (run_id, business_id, entity_type, entity_id, entity_label, copies, resolved_vars, status)
      SELECT r.id, r.business_id, 'location', s.id, s.name, r.copies,
             public.label_vars_for_location(r.business_id, s.id), 'pending'
      FROM src s;
      GET DIAGNOSTICS v_inserted = ROW_COUNT;

    ELSE
      UPDATE public.label_print_runs SET status='failed', last_error='unknown_selection_kind:'||v_kind WHERE id = r.id;
      RETURN jsonb_build_object('error','unknown_selection_kind');
    END IF;

    IF v_inserted < v_batch THEN
      UPDATE public.label_print_runs SET expansion_complete = true, status = 'running' WHERE id = r.id;
    ELSE
      UPDATE public.label_print_runs SET status = 'running' WHERE id = r.id;
    END IF;
  END IF;

  ------------------------------------------------------------------
  -- 2. Refuse lines with no printable identity (ADR-0089)
  ------------------------------------------------------------------
  UPDATE public.label_print_run_lines l
     SET status = 'refused',
         error = 'no printable barcode identity for this item'
   WHERE l.run_id = r.id
     AND l.status = 'pending'
     AND COALESCE(l.resolved_vars->>'barcode', '') = '';

  ------------------------------------------------------------------
  -- 3. Enqueue print jobs for pending lines (bounded)
  ------------------------------------------------------------------
  WITH pend AS (
    SELECT l.id, l.entity_id, l.copies, l.resolved_vars
    FROM public.label_print_run_lines l
    WHERE l.run_id = r.id AND l.status = 'pending'
    ORDER BY l.created_at
    LIMIT v_batch
    FOR UPDATE SKIP LOCKED
  ), jobs AS (
    INSERT INTO public.print_jobs (
      business_id, branch_id, doc_type, doc_id, intent, format, medium, disposition,
      hardware_role, media_profile_id, copies, correlation_id, dedupe_key, status,
      triggered_source, scenario, render_params, requested_by
    )
    SELECT r.business_id, r.branch_id, r.template_key, p.entity_id, 'label', v_engine,
           v_engine::public.output_medium, 'print'::public.output_disposition,
           'label_printer', v_media, p.copies,
           'label_run:'||r.id::text, 'label_run:'||r.id::text||':'||p.entity_id::text,
           'queued'::public.print_job_status, 'label_run', r.workflow,
           jsonb_build_object(
             'template_key', r.template_key,
             'workflow', r.workflow,
             'label_run_id', r.id,
             'run_line_id', p.id,
             'vars', p.resolved_vars
           ),
           r.created_by
    FROM pend p
    RETURNING id, (render_params->>'run_line_id')::uuid AS line_id
  )
  UPDATE public.label_print_run_lines l
     SET status = 'queued', print_job_id = j.id
    FROM jobs j
   WHERE l.id = j.line_id;
  GET DIAGNOSTICS v_queued = ROW_COUNT;

  ------------------------------------------------------------------
  -- 4. Recompute counters / completion
  ------------------------------------------------------------------
  PERFORM public.recount_label_run(r.id);

  RETURN jsonb_build_object('run_id', r.id, 'expanded', v_inserted, 'queued', v_queued);
END;
$$;
GRANT EXECUTE ON FUNCTION public.expand_label_run(uuid,integer) TO authenticated, service_role;

-- ---------------- var resolvers ----------------
CREATE OR REPLACE FUNCTION public.label_vars_for_product(p_business_id uuid, p_product_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'product_id', p.id,
    'name', COALESCE(p.name,''),
    'product_name', COALESCE(p.name,''),
    'sku', COALESCE(p.sku,''),
    'barcode', COALESCE(
      (SELECT pi.code FROM public.product_identifiers pi
        WHERE pi.product_id = p.id AND pi.status = 'active'
        ORDER BY pi.is_primary DESC, pi.created_at ASC LIMIT 1),
      NULLIF(p.sku,''), ''),
    'price', to_char(COALESCE(p.unit_price,0), 'FM999999990.00'),
    'price_raw', COALESCE(p.unit_price, 0),
    'uom', COALESCE((SELECT u.code FROM public.units_of_measure u WHERE u.id = p.base_uom_id), ''),
    'hri', 'Y'
  )
  FROM public.products p
  WHERE p.id = p_product_id AND p.business_id = p_business_id;
$$;
GRANT EXECUTE ON FUNCTION public.label_vars_for_product(uuid,uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.label_vars_for_location(p_business_id uuid, p_location_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'location_id', sl.id,
    'name', COALESCE(sl.name,''),
    'code', COALESCE(sl.code,''),
    'barcode', COALESCE(NULLIF(sl.barcode,''), NULLIF(sl.code,''), ''),
    'warehouse_id', sl.warehouse_id,
    'hri', 'Y'
  )
  FROM public.stock_locations sl
  WHERE sl.id = p_location_id AND sl.business_id = p_business_id;
$$;
GRANT EXECUTE ON FUNCTION public.label_vars_for_location(uuid,uuid) TO authenticated, service_role;

-- ---------------- counters ----------------
CREATE OR REPLACE FUNCTION public.recount_label_run(p_run_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE t int; q int; pr int; f int; rf int; done boolean; v_exp boolean;
BEGIN
  SELECT count(*),
         count(*) FILTER (WHERE status = 'queued'),
         count(*) FILTER (WHERE status = 'printed'),
         count(*) FILTER (WHERE status = 'failed'),
         count(*) FILTER (WHERE status = 'refused')
    INTO t, q, pr, f, rf
  FROM public.label_print_run_lines WHERE run_id = p_run_id;

  SELECT expansion_complete INTO v_exp FROM public.label_print_runs WHERE id = p_run_id;
  done := COALESCE(v_exp,false) AND t > 0 AND (pr + f + rf) = t;

  UPDATE public.label_print_runs
     SET total_lines = t, queued_lines = q, printed_lines = pr,
         failed_lines = f, refused_lines = rf,
         status = CASE WHEN status IN ('cancelled','paused') THEN status
                       WHEN done THEN 'completed'::public.label_run_status
                       ELSE status END,
         completed_at = CASE WHEN done THEN COALESCE(completed_at, now()) ELSE completed_at END
   WHERE id = p_run_id;
END;
$$;
GRANT EXECUTE ON FUNCTION public.recount_label_run(uuid) TO authenticated, service_role;

-- ---------------- print_jobs -> line status sync ----------------
CREATE OR REPLACE FUNCTION public._label_sync_line_from_job()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_run uuid;
BEGIN
  IF NEW.intent IS DISTINCT FROM 'label' THEN RETURN NEW; END IF;
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;

  UPDATE public.label_print_run_lines l
     SET status = CASE
           WHEN NEW.status IN ('sent','acked') THEN 'printed'::public.label_run_line_status
           WHEN NEW.status IN ('failed','abandoned','dead_letter') THEN 'failed'::public.label_run_line_status
           ELSE l.status END,
         error = CASE WHEN NEW.status IN ('failed','abandoned','dead_letter') THEN NEW.last_error ELSE l.error END
   WHERE l.print_job_id = NEW.id
  RETURNING l.run_id INTO v_run;

  IF v_run IS NOT NULL THEN PERFORM public.recount_label_run(v_run); END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_label_sync_line_from_job
  AFTER UPDATE OF status ON public.print_jobs
  FOR EACH ROW EXECUTE FUNCTION public._label_sync_line_from_job();

-- ---------------- run control ----------------
CREATE OR REPLACE FUNCTION public.set_label_run_status(p_run_id uuid, p_status public.label_run_status)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_biz uuid;
BEGIN
  SELECT business_id INTO v_biz FROM public.label_print_runs WHERE id = p_run_id;
  IF v_biz IS NULL OR NOT public.user_has_business_access(auth.uid(), v_biz) THEN
    RAISE EXCEPTION 'set_label_run_status: no access' USING ERRCODE = '42501';
  END IF;
  IF p_status NOT IN ('paused','running','cancelled') THEN
    RAISE EXCEPTION 'set_label_run_status: unsupported target %', p_status;
  END IF;
  UPDATE public.label_print_runs SET status = p_status WHERE id = p_run_id;
  IF p_status = 'cancelled' THEN
    UPDATE public.print_jobs SET status = 'abandoned', last_error = 'label run cancelled'
     WHERE intent = 'label' AND correlation_id = 'label_run:'||p_run_id::text AND status = 'queued';
  END IF;
END;
$$;
GRANT EXECUTE ON FUNCTION public.set_label_run_status(uuid, public.label_run_status) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.retry_label_run_failures(p_run_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_biz uuid; n int;
BEGIN
  SELECT business_id INTO v_biz FROM public.label_print_runs WHERE id = p_run_id;
  IF v_biz IS NULL OR NOT public.user_has_business_access(auth.uid(), v_biz) THEN
    RAISE EXCEPTION 'retry_label_run_failures: no access' USING ERRCODE = '42501';
  END IF;
  UPDATE public.label_print_run_lines
     SET status = 'pending', print_job_id = NULL, error = NULL
   WHERE run_id = p_run_id AND status = 'failed';
  GET DIAGNOSTICS n = ROW_COUNT;
  UPDATE public.label_print_runs SET status = 'running', completed_at = NULL WHERE id = p_run_id;
  RETURN n;
END;
$$;
GRANT EXECUTE ON FUNCTION public.retry_label_run_failures(uuid) TO authenticated, service_role;

-- ---------------- worker claim ----------------
CREATE OR REPLACE FUNCTION public.claim_label_runs(p_limit integer DEFAULT 5)
RETURNS SETOF uuid LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT id FROM public.label_print_runs
   WHERE status IN ('expanding','running')
     AND (expansion_complete = false
          OR EXISTS (SELECT 1 FROM public.label_print_run_lines l WHERE l.run_id = label_print_runs.id AND l.status = 'pending'))
   ORDER BY created_at
   LIMIT GREATEST(COALESCE(p_limit,5),1);
$$;
GRANT EXECUTE ON FUNCTION public.claim_label_runs(integer) TO service_role;