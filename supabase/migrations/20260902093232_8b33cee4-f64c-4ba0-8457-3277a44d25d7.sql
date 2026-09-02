DO $fix$
DECLARE f record; src text;
BEGIN
  FOR f IN
    SELECT p.oid
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN (
         'post_journal_entry_atomic',
         'void_journal_entry_atomic',
         'enforce_journal_entry_immutability',
         'enforce_journal_entry_lines_immutability',
         'sync_balances_on_je_status_change',
         'assert_no_existing_source_posting',
         '_jel_sync_analytics'
       )
       AND p.prosrc LIKE '%''voided''%'
  LOOP
    src := replace(pg_get_functiondef(f.oid), '''voided''', '''void''');
    EXECUTE src;
  END LOOP;
END
$fix$;