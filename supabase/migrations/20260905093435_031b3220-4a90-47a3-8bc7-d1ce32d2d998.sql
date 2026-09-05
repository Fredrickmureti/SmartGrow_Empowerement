DO $do$
DECLARE
  v_src text;
  v_new text;
BEGIN
  -- 1) post_journal_entry_atomic (18-arg): idempotency guard compared
  -- journal_entries.status (enum journal_status = draft|posted|void) to the
  -- non-existent value 'voided', raising 22P02 on every posting.
  v_src := pg_get_functiondef('public.post_journal_entry_atomic(uuid,uuid,text,date,text,text,text,uuid,uuid,boolean,boolean,jsonb,text,numeric,text,uuid,boolean,boolean)'::regprocedure);
  v_new := replace(v_src, 'AND status <> ''voided''', 'AND status::text <> ''void''');
  IF v_new = v_src THEN
    RAISE EXCEPTION 'post_journal_entry_atomic: expected status guard not found; aborting';
  END IF;
  EXECUTE v_new;
END
$do$;