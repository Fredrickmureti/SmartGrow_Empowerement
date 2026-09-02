DO $fix$
DECLARE src text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'guard_journal_entry_self_approval';

  src := replace(src, '_sod_is_approved_status(NEW.status)', '_sod_is_approved_status(NEW.status::text)');
  src := replace(src, '_sod_is_approved_status(COALESCE(OLD.status,''''))', '_sod_is_approved_status(COALESCE(OLD.status::text,''''))');
  EXECUTE src;
END
$fix$;