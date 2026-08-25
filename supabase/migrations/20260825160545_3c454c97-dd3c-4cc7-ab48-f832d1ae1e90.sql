drop function if exists public.project_employee_cost_rate(uuid, uuid);

create function public.project_employee_cost_rate(_project_id uuid, _employee_id uuid)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select
    coalesce(
      (select nullif(e.cost_rate_override, 0) from public.employees e where e.id = _employee_id),
      (select nullif(p.hourly_rate, 0) from public.projects p where p.id = _project_id),
      0
    )
    * (1 + coalesce(
        (select e.labor_burden_pct from public.employees e where e.id = _employee_id),
        0
      ) / 100.0);
$$;

revoke execute on function public.project_employee_cost_rate(uuid, uuid) from public, anon;
grant execute on function public.project_employee_cost_rate(uuid, uuid) to authenticated, service_role;