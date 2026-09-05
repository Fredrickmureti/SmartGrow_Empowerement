DO $mig$
DECLARE v_def text; v_old text; v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname='public' AND p.proname='mf_post_event';

  v_old := '    _exchange_rate  => 1,
    _source_subtype => ev.event_type,
    _branch_id      => l.branch_id);';

  v_new := '    _exchange_rate  => 1::numeric,
    _source_subtype => ev.event_type,
    _branch_id      => l.branch_id,
    _is_opening_entry => false,
    _amounts_in_document_currency => false);';

  IF position(v_old IN v_def) = 0 THEN
    RAISE EXCEPTION 'expected posting call not found; aborting';
  END IF;

  EXECUTE replace(v_def, v_old, v_new);
END $mig$;