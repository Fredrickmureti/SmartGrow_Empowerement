
create table if not exists public.workstations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  name text not null,
  secret_hash text not null,
  version text,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists workstations_org_idx on public.workstations (organization_id);
grant select, insert, update, delete on public.workstations to authenticated;
grant all on public.workstations to service_role;
alter table public.workstations enable row level security;
create policy "workstations_select_org" on public.workstations for select to authenticated
  using (organization_id in (select public.get_user_organizations(auth.uid())));
create policy "workstations_insert_org" on public.workstations for insert to authenticated
  with check (organization_id in (select public.get_user_organizations(auth.uid())));
create policy "workstations_update_org" on public.workstations for update to authenticated
  using (organization_id in (select public.get_user_organizations(auth.uid())))
  with check (organization_id in (select public.get_user_organizations(auth.uid())));
create policy "workstations_delete_org" on public.workstations for delete to authenticated
  using (organization_id in (select public.get_user_organizations(auth.uid())));

create table if not exists public.edge_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  workstation_id uuid not null references public.workstations(id) on delete cascade,
  requested_by uuid,
  role text not null,
  op text not null default 'exec',
  payload jsonb not null default '{}'::jsonb,
  idempotency_key text,
  status text not null default 'queued',
  result jsonb,
  error text,
  deadline_at timestamptz not null default (now() + interval '30 seconds'),
  claimed_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint edge_jobs_status_check check (status in ('queued','in_progress','done','error','expired'))
);
create index if not exists edge_jobs_workstation_status_idx on public.edge_jobs (workstation_id, status, created_at);
create unique index if not exists edge_jobs_idem_uk on public.edge_jobs (organization_id, workstation_id, idempotency_key) where idempotency_key is not null;
grant select, insert, update on public.edge_jobs to authenticated;
grant all on public.edge_jobs to service_role;
alter table public.edge_jobs enable row level security;

create policy "edge_jobs_insert_org" on public.edge_jobs for insert to authenticated
  with check (
    organization_id in (select public.get_user_organizations(auth.uid()))
    and exists (
      select 1 from public.workstations w
      where w.id = workstation_id and w.organization_id = edge_jobs.organization_id
    )
  );
create policy "edge_jobs_select_org" on public.edge_jobs for select to authenticated
  using (organization_id in (select public.get_user_organizations(auth.uid())));
create policy "edge_jobs_update_org_cancel" on public.edge_jobs for update to authenticated
  using (organization_id in (select public.get_user_organizations(auth.uid())))
  with check (organization_id in (select public.get_user_organizations(auth.uid())));

create or replace function public.edge_jobs_expire_stale()
returns integer language sql security definer set search_path = public as $$
  with u as (
    update public.edge_jobs
       set status='expired',
           error=coalesce(error,'deadline exceeded'),
           updated_at=now(),
           completed_at=coalesce(completed_at, now())
     where status in ('queued','in_progress') and deadline_at < now()
     returning 1
  ) select coalesce(count(*),0)::int from u;
$$;

alter publication supabase_realtime add table public.edge_jobs;
