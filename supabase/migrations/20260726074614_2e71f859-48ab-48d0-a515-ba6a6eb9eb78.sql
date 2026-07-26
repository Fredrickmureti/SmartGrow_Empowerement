create or replace function public.edge_jobs_expire_stale()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  affected integer := 0;
begin
  update public.edge_jobs
     set status = 'expired',
         error = coalesce(error, 'deadline exceeded'),
         updated_at = now(),
         completed_at = coalesce(completed_at, now())
   where status in ('queued', 'in_progress')
     and deadline_at < now();

  get diagnostics affected = row_count;
  return affected;
end;
$$;

grant execute on function public.edge_jobs_expire_stale() to anon, authenticated, service_role;