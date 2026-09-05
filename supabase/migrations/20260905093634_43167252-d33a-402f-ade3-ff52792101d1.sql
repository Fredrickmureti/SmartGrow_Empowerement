DO $do$
DECLARE
  v_src text;
  v_new text;
BEGIN
  v_src := pg_get_functiondef('public.mf_post_event(uuid)'::regprocedure);
  v_new := replace(
    v_src,
    '_entry_date     => COALESCE(ev.event_at::date, CURRENT_DATE),',
    '_entry_date     => COALESCE(
                         (ev.payload->>''paid_on'')::date,
                         (ev.payload->>''disbursed_on'')::date,
                         (ev.payload->>''settled_on'')::date,
                         (ev.payload->>''written_off_on'')::date,
                         (ev.payload->>''effective_on'')::date,
                         ev.event_at::date, CURRENT_DATE),');
  IF v_new = v_src THEN
    RAISE EXCEPTION 'mf_post_event: expected _entry_date argument not found; aborting';
  END IF;
  EXECUTE v_new;
END
$do$;