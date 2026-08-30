-- M4 · drop the hardware command link from the print-job ledger.
drop function if exists public.print_job_mark_acked(bigint);
drop function if exists public.mark_print_job_dispatched(uuid, uuid, bigint);
drop function if exists public.print_job_mark_sent(uuid, bigint);
drop function if exists public.print_jobs_settle(uuid[], bigint);

alter table public.print_jobs drop column if exists hw_command_id;

create or replace function public.print_job_mark_sent(p_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  update public.print_jobs
     set status  = 'sent',
         sent_at = coalesce(sent_at, now())
   where id = p_id;
end;
$function$;

revoke all on function public.print_job_mark_sent(uuid) from public;
grant execute on function public.print_job_mark_sent(uuid) to authenticated, service_role;

create or replace function public.print_jobs_settle(p_ids uuid[])
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_count int := 0;
begin
  if p_ids is null or array_length(p_ids, 1) is null then
    return 0;
  end if;

  update public.print_jobs pj
     set status   = 'acked',
         sent_at  = coalesce(pj.sent_at, now()),
         acked_at = coalesce(pj.acked_at, now())
   where pj.id = any(p_ids)
     and pj.status in ('queued', 'sent')
     and (
       auth.role() = 'service_role'
       or exists (
         select 1 from public.user_business_access uba
          where uba.user_id = auth.uid()
            and uba.business_id = pj.business_id
       )
     );
  get diagnostics v_count = row_count;

  update public.print_jobs p
     set status   = 'acked',
         acked_at = coalesce(p.acked_at, now())
   where p.id in (
           select distinct parent_job_id from public.print_jobs
            where id = any(p_ids) and parent_job_id is not null
         )
     and p.status in ('queued', 'sent')
     and not exists (
       select 1 from public.print_jobs c
        where c.parent_job_id = p.id and c.status <> 'acked'
     );

  return v_count;
end;
$function$;

revoke all on function public.print_jobs_settle(uuid[]) from public;
grant execute on function public.print_jobs_settle(uuid[]) to authenticated, service_role;