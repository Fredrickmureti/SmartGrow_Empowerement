-- Location branch defect: the engine looked up selected bins in
-- public.warehouse_locations while the UI (and label_vars_for_location)
-- both use public.stock_locations, so bin runs expanded to zero lines.
-- The branch also lacked a business_id predicate.
CREATE OR REPLACE FUNCTION public.expand_label_run(p_run_id uuid, p_batch_size integer DEFAULT 500)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $function$
DECLARE
  r public.label_print_runs%ROWTYPE;
  v_spec jsonb;
  v_kind text;
  v_inserted integer := 0;
  v_queued integer := 0;
  v_engine text;
  v_media uuid;
  v_batch integer := LEAST(GREATEST(COALESCE(p_batch_size,500),1), 2000);
  v_saved jsonb;
BEGIN
  SELECT * INTO r FROM public.label_print_runs WHERE id = p_run_id FOR UPDATE;
  IF r.id IS NULL THEN RETURN jsonb_build_object('error','run_not_found'); END IF;
  IF r.status NOT IN ('expanding','running') THEN
    RETURN jsonb_build_object('status', r.status::text, 'skipped', true);
  END IF;

  v_spec := COALESCE(r.selection_spec, '{}'::jsonb);
  v_kind := COALESCE(v_spec->>'kind', 'product_ids');

  IF v_kind = 'product_filter' AND (v_spec->>'saved_view_id') IS NOT NULL THEN
    v_saved := public.label_saved_view_filter((v_spec->>'saved_view_id')::uuid, r.business_id);
    v_spec := v_saved || v_spec;
  END IF;

  SELECT lt.engine::text, lt.media_profile_id INTO v_engine, v_media
  FROM public.label_templates lt
  WHERE lt.org_id = r.organization_id
    AND lt.template_key = r.template_key
    AND lt.active
  ORDER BY (lt.branch_id = r.branch_id) DESC NULLS LAST, lt.version DESC
  LIMIT 1;
  v_engine := COALESCE(v_engine, 'zpl');

  IF NOT r.expansion_complete THEN
    IF v_kind = 'product_ids' THEN
      WITH src AS (
        SELECT p.id, p.name
        FROM public.products p
        WHERE p.business_id = r.business_id
          AND p.id = ANY (SELECT (jsonb_array_elements_text(v_spec->'ids'))::uuid)
          AND NOT EXISTS (SELECT 1 FROM public.label_print_run_lines l WHERE l.run_id = r.id AND l.entity_id = p.id)
        ORDER BY p.id
        LIMIT v_batch
      )
      INSERT INTO public.label_print_run_lines (run_id, business_id, entity_type, entity_id, entity_label, copies, resolved_vars, status)
      SELECT r.id, r.business_id, 'product', s.id, s.name, r.copies,
             public.label_vars_for_product(r.business_id, s.id), 'pending'
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
                    WHEN r.entity_type = 'carton'
                    THEN public.label_vars_for_carton(r.business_id, s.entity_id)
                    ELSE public.label_vars_for_location(r.business_id, s.entity_id) END,
               'pending'
        FROM src s
        RETURNING entity_id
      )
      UPDATE public.label_demand d SET status = 'queued', updated_at = now()
      WHERE d.id IN (SELECT demand_id FROM src);
      GET DIAGNOSTICS v_inserted = ROW_COUNT;

    ELSIF v_kind = 'location_ids' THEN
      WITH src AS (
        SELECT sl.id, COALESCE(sl.name, sl.code) AS name
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

    ELSIF v_kind IN ('carton_ids', 'pack_wave') THEN
      WITH src AS (
        SELECT c.id, COALESCE(lp.code, left(c.id::text, 8)) AS name
        FROM public.wms_pack_cartons c
        LEFT JOIN public.wms_license_plates lp ON lp.id = c.shipment_lpn_id
        WHERE c.business_id = r.business_id
          AND (
            (v_kind = 'carton_ids'
              AND c.id = ANY (SELECT (jsonb_array_elements_text(v_spec->'ids'))::uuid))
            OR
            (v_kind = 'pack_wave'
              AND c.wave_id = (v_spec->>'wave_id')::uuid
              AND (COALESCE((v_spec->>'sealed_only')::boolean, true) IS NOT TRUE OR c.sealed_at IS NOT NULL))
          )
          AND NOT EXISTS (SELECT 1 FROM public.label_print_run_lines l WHERE l.run_id = r.id AND l.entity_id = c.id)
        ORDER BY c.id
        LIMIT v_batch
      )
      INSERT INTO public.label_print_run_lines (run_id, business_id, entity_type, entity_id, entity_label, copies, resolved_vars, status)
      SELECT r.id, r.business_id, 'carton', s.id, s.name, r.copies,
             public.label_vars_for_carton(r.business_id, s.id), 'pending'
      FROM src s;
      GET DIAGNOSTICS v_inserted = ROW_COUNT;
    END IF;

    IF v_inserted < v_batch THEN
      UPDATE public.label_print_runs SET expansion_complete = true, status = 'running', updated_at = now()
      WHERE id = r.id;
    ELSE
      UPDATE public.label_print_runs SET status = 'expanding', updated_at = now() WHERE id = r.id;
    END IF;
  END IF;

  WITH pending AS (
    SELECT l.*
    FROM public.label_print_run_lines l
    WHERE l.run_id = r.id AND l.status = 'pending'
    ORDER BY l.created_at
    LIMIT v_batch
    FOR UPDATE SKIP LOCKED
  ), refused AS (
    UPDATE public.label_print_run_lines l
    SET status = 'refused',
        error = 'No printable identity (ADR-0089): item has no barcode or SKU to encode',
        updated_at = now()
    FROM pending p
    WHERE l.id = p.id
      AND COALESCE(p.resolved_vars->>'barcode', '') = ''
    RETURNING l.id
  ), printable AS (
    SELECT p.* FROM pending p
    WHERE COALESCE(p.resolved_vars->>'barcode', '') <> ''
  ), jobs AS (
    INSERT INTO public.print_jobs (
      organization_id, business_id, branch_id, doc_type, intent, transport,
      status, payload, correlation_id, dedupe_key, requested_by, requested_at,
      template_key, copies
    )
    SELECT r.organization_id, r.business_id, r.branch_id, 'label', 'label', 'thermal',
           'queued',
           jsonb_build_object(
             'template_key', r.template_key,
             'workflow', r.workflow,
             'engine', v_engine,
             'media_profile_id', v_media,
             'vars', pr.resolved_vars,
             'run_id', r.id,
             'line_id', pr.id
           ),
           'label_run:' || r.id::text || ':' || pr.entity_id::text,
           'label_run:' || r.id::text || ':' || pr.id::text,
           r.created_by, now(), r.template_key, pr.copies
    FROM printable pr
    ON CONFLICT DO NOTHING
    RETURNING (payload->>'line_id')::uuid AS line_id
  )
  UPDATE public.label_print_run_lines l
  SET status = 'queued', updated_at = now()
  WHERE l.id IN (SELECT line_id FROM jobs);
  GET DIAGNOSTICS v_queued = ROW_COUNT;

  PERFORM public.recount_label_run(r.id);

  SELECT * INTO r FROM public.label_print_runs WHERE id = p_run_id;

  RETURN jsonb_build_object(
    'run_id', r.id,
    'status', r.status::text,
    'inserted', v_inserted,
    'queued', v_queued,
    'expansion_complete', r.expansion_complete,
    'total_lines', r.total_lines
  );
END;
$function$;