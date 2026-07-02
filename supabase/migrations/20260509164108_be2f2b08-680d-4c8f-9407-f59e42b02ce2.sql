
create or replace view public.project_member_workload_week
with (security_invoker = on) as
with weeks as (
  select date_trunc('week', d)::date as week_start
  from generate_series(date_trunc('week', now())::date - interval '4 weeks',
                       date_trunc('week', now())::date + interval '8 weeks',
                       interval '1 week') as g(d)
),
planned as (
  select pt.assigned_to as user_id,
         pt.business_id,
         date_trunc('week', coalesce(pt.deadline, now()::date))::date as week_start,
         coalesce(sum(pt.planned_hours), 0)::numeric as planned_hours
  from public.project_tasks pt
  where pt.assigned_to is not null and pt.is_active = true and pt.is_done = false
  group by 1,2,3
),
logged as (
  select e.user_id,
         t.business_id,
         date_trunc('week', t.date)::date as week_start,
         coalesce(sum(t.hours), 0)::numeric as logged_hours
  from public.timesheets t
  join public.employees e on e.id = t.employee_id
  where e.user_id is not null
  group by 1,2,3
),
members as (
  select distinct pm.user_id, p.business_id
  from public.project_members pm
  join public.projects p on p.id = pm.project_id
  where pm.user_id is not null
)
select
  w.week_start,
  m.user_id,
  m.business_id,
  coalesce(p.planned_hours, 0)::numeric as planned_hours,
  coalesce(l.logged_hours, 0)::numeric as logged_hours,
  40::numeric as capacity_hours,
  (coalesce(l.logged_hours, 0) > 40)::boolean as over_capacity
from weeks w
cross join members m
left join planned p on p.user_id = m.user_id and p.business_id = m.business_id and p.week_start = w.week_start
left join logged l on l.user_id = m.user_id and l.business_id = m.business_id and l.week_start = w.week_start;

comment on view public.project_member_workload_week is
  'Per-member, per-week planned vs logged hours vs capacity (default 40h). Security invoker — RLS of underlying tables applies.';

create table if not exists public.project_digest_log (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id uuid not null,
  sent_for_week date not null,
  sent_at timestamptz not null default now(),
  unique (project_id, user_id, sent_for_week)
);
create index if not exists idx_project_digest_log_week
  on public.project_digest_log (sent_for_week, user_id);

alter table public.project_digest_log enable row level security;

drop policy if exists "members read own digest log" on public.project_digest_log;
create policy "members read own digest log"
  on public.project_digest_log for select
  using (user_id = auth.uid());
