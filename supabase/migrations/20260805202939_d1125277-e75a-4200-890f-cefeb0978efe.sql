CREATE OR REPLACE FUNCTION public.expand_label_run(p_run_id uuid, p_batch_size integer DEFAULT 500)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r public.label_print_runs%ROWTYPE;
  v_spec jsonb;
  v_kind text;
  v_inserted integer := 0;
  v_queued integer := 0;
  v_relinked integer := 0;
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

  -- ADR-0088: a run must never guess geometry. When the template pins no
  -- media, fall back to the org's default label media rather than letting
  -- the driver assume a dot pitch.
  IF v_media IS NULL THEN
    SELECT mp.id INTO v_media
    FROM public.media_profiles mp
    WHERE mp.org_id = r.organization_id
      AND mp.active
    ORDER BY (mp.kind = 'label') DESC NULLS LAST, mp.is_default DESC NULLS LAST, mp.created_at
    LIMIT 1;
  END IF;

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
      business_id, branch_id, doc_type, intent, format, transport,
      hardware_role, media_profile_id, status, disposition, medium, render_params,
      correlation_id, dedupe_key, requested_by, requested_at, copies
    )
    SELECT r.business_id, r.branch_id, 'label', 'label', v_engine, 'thermal',
           'label_printer', v_media, 'queued', 'print'::public.output_disposition,
           (CASE WHEN v_engine = 'escpos' THEN 'escpos' ELSE 'zpl' END)::public.output_medium,
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
           r.created_by, now(), pr.copies
    FROM printable pr
    ON CONFLICT DO NOTHING
    RETURNING id AS job_id, (render_params->>'line_id')::uuid AS line_id
  )
  UPDATE public.label_print_run_lines l
  SET status = 'queued', print_job_id = j.job_id, updated_at = now()
  FROM jobs j
  WHERE l.id = j.line_id;
  GET DIAGNOSTICS v_queued = ROW_COUNT;

  -- Recovery: a line whose job already existed (dedupe hit, so the INSERT
  -- returned nothing) would otherwise stay 'pending' forever. Re-link it to
  -- the job that owns its deterministic dedupe key.
  UPDATE public.label_print_run_lines l
  SET status = 'queued', print_job_id = pj.id, updated_at = now()
  FROM public.print_jobs pj
  WHERE l.run_id = r.id
    AND l.status = 'pending'
    AND COALESCE(l.resolved_vars->>'barcode','') <> ''
    AND pj.dedupe_key = 'label_run:' || r.id::text || ':' || l.id::text;
  GET DIAGNOSTICS v_relinked = ROW_COUNT;

  PERFORM public.recount_label_run(r.id);

  SELECT * INTO r FROM public.label_print_runs WHERE id = p_run_id;

  RETURN jsonb_build_object(
    'run_id', r.id,
    'status', r.status::text,
    'inserted', v_inserted,
    'queued', v_queued + v_relinked,
    'expansion_complete', r.expansion_complete,
    'total_lines', r.total_lines
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public._label_sync_line_from_job()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_run uuid;
BEGIN
  IF NEW.intent IS DISTINCT FROM 'label' THEN RETURN NEW; END IF;
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;

  -- Match on the job linkage first, and fall back to the line id carried in
  -- render_params so a job created before linkage existed still reconciles.
  UPDATE public.label_print_run_lines l
     SET status = CASE
           WHEN NEW.status IN ('sent','acked') THEN 'printed'::public.label_run_line_status
           WHEN NEW.status IN ('failed','abandoned','dead_letter') THEN 'failed'::public.label_run_line_status
           ELSE l.status END,
         error = CASE WHEN NEW.status IN ('failed','abandoned','dead_letter') THEN NEW.last_error ELSE l.error END,
         print_job_id = COALESCE(l.print_job_id, NEW.id)
   WHERE l.print_job_id = NEW.id
      OR (l.print_job_id IS NULL
          AND NEW.render_params ? 'line_id'
          AND l.id = (NEW.render_params->>'line_id')::uuid)
  RETURNING l.run_id INTO v_run;

  IF v_run IS NOT NULL THEN PERFORM public.recount_label_run(v_run); END IF;
  RETURN NEW;
END;
$function$;