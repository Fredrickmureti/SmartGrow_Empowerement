-- M4 · retire the label printing subsystem (no label printer estate).
select cron.unschedule('purge-label-run-lines-nightly');

drop table if exists public.label_print_run_lines cascade;
drop table if exists public.label_print_runs cascade;
drop table if exists public.label_demand cascade;
drop table if exists public.label_templates cascade;

do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure::text as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname ~ 'label'
  loop
    execute format('drop function if exists %s cascade', r.sig);
  end loop;
end $$;

drop type if exists public.label_demand_reason cascade;
drop type if exists public.label_demand_status cascade;
drop type if exists public.label_engine cascade;
drop type if exists public.label_entity_type cascade;
drop type if exists public.label_run_line_status cascade;
drop type if exists public.label_run_status cascade;