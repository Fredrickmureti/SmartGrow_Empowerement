-- M4 · retire the device registry (no managed printer/scanner estate).
alter table public.document_print_policies drop column if exists device_assignment_id;
alter table public.attendance_devices drop column if exists device_assignment_id;

drop table if exists public.device_workflow_bindings cascade;
drop table if exists public.device_assignments cascade;
drop table if exists public.printer_roles cascade;
drop table if exists public.scanner_device_labels cascade;
drop table if exists public.scanner_device_trust cascade;

do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure::text as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in (
         'resolve_device',
         'resolve_device_for_workflow',
         'resolve_workflow_printer',
         '_bootstrap_printer_roles',
         '_seed_default_printer_roles',
         'touch_device_assignments_updated_at',
         'tg_mirror_attendance_device_to_assignment',
         'pos_rename_scanner_device',
         'scanner_issue_trust',
         'scanner_reclaim_session',
         'scanner_revoke_trust'
       )
  loop
    execute format('drop function if exists %s cascade', r.sig);
  end loop;
end $$;