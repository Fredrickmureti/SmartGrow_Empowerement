DO $mig$
DECLARE
  v_def text;
  v_old text;
  v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'mf_post_event';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'mf_post_event not found';
  END IF;

  v_old := '  v_je := public.post_journal_entry_atomic(
    v_org, ev.business_id, l.branch_id, COALESCE(ev.event_at::date, CURRENT_DATE),
    v_desc, v_ref, v_lines);';

  v_new := '  v_je := public.post_journal_entry_atomic(
    _org_id         => v_org,
    _business_id    => ev.business_id,
    _entry_number   => NULL,
    _entry_date     => COALESCE(ev.event_at::date, CURRENT_DATE),
    _reference      => v_ref,
    _description    => v_desc,
    _source_type    => ''mf_loan_event'',
    _source_id      => ev.id,
    _created_by     => COALESCE(ev.actor_id, auth.uid()),
    _is_closing     => false,
    _is_adjusting   => false,
    _lines          => v_lines,
    _currency       => COALESCE(l.currency_code,
                                (SELECT b.base_currency FROM public.businesses b WHERE b.id = ev.business_id)),
    _exchange_rate  => 1,
    _source_subtype => ev.event_type,
    _branch_id      => l.branch_id);';

  IF position(v_old IN v_def) = 0 THEN
    RAISE EXCEPTION 'mf_post_event does not contain the expected legacy posting call; aborting';
  END IF;

  EXECUTE replace(v_def, v_old, v_new);
END $mig$;