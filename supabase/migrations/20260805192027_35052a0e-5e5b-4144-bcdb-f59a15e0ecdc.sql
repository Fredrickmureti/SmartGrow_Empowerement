-- Defect 2 (found by the volume proof): print_jobs enforces UNIQUE
-- (business_id, correlation_id), but expand_label_run stamped the SAME
-- correlation id ('label_run:<run>') on every line of a run. A run could
-- therefore enqueue exactly one job; line 2 aborted the pass with 23505.
-- Correlation becomes per line (run + entity), matching the dedupe key.
-- set_label_run_status must then match on the prefix, not equality, or
-- cancellation would silently stop cancelling anything.
DO $mig$
DECLARE
  v_def text;
  v_new text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def
  FROM pg_proc
  WHERE proname = 'expand_label_run' AND pronamespace = 'public'::regnamespace;

  v_new := replace(
    v_def,
    '''label_run:''||r.id::text, ''label_run:''||r.id::text||'':''||p.entity_id::text,',
    '''label_run:''||r.id::text||'':''||p.entity_id::text, ''label_run:''||r.id::text||'':''||p.entity_id::text,'
  );
  IF v_new = v_def THEN
    RAISE EXCEPTION 'expand_label_run: correlation_id expression not found';
  END IF;
  EXECUTE v_new;
END;
$mig$;

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
    -- correlation is now per line: 'label_run:<run>:<entity>'
    UPDATE public.print_jobs SET status = 'abandoned', last_error = 'label run cancelled'
     WHERE intent = 'label'
       AND business_id = v_biz
       AND correlation_id LIKE 'label_run:'||p_run_id::text||':%'
       AND status = 'queued';
  END IF;
END;
$$;
GRANT EXECUTE ON FUNCTION public.set_label_run_status(uuid, public.label_run_status) TO authenticated, service_role;