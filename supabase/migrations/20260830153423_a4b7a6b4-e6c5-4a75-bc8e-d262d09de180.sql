-- M4 · retire the hardware command relay (no edge agent, no device estate).
select cron.unschedule('cleanup-hardware-exec-log-daily');

drop table if exists public.hardware_exec_log cascade;
drop table if exists public.hardware_command_queue cascade;

do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure::text as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in (
         'claim_next_hardware_command',
         'complete_hardware_command',
         'enqueue_hardware_command',
         'reclaim_stale_hardware_commands',
         'cleanup_old_hardware_exec_log'
       )
  loop
    execute format('drop function if exists %s cascade', r.sig);
  end loop;
end $$;

drop type if exists public.hardware_command_status cascade;