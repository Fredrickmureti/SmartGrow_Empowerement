
-- =====================================================================
-- Phase B — Succession Planning & 9-Box Talent Grid
-- =====================================================================

-- ---------- helper: is_talent_admin ----------
create or replace function public.is_talent_admin(_user_id uuid, _org_id uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select
    public.has_role(_user_id, _org_id, 'owner'::public.app_role)
    or public.has_role(_user_id, _org_id, 'admin'::public.app_role)
    or public.has_role(_user_id, _org_id, 'super_admin'::public.app_role);
$$;

-- ---------- 1. talent_pools ----------
create table if not exists public.talent_pools (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  business_id uuid,
  name text not null,
  description text,
  pool_type text not null default 'general'
    check (pool_type in ('general','high_potential','critical_role','successor','retention_risk','leadership')),
  is_active boolean not null default true,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, name)
);
grant select, insert, update, delete on public.talent_pools to authenticated;
grant all on public.talent_pools to service_role;
alter table public.talent_pools enable row level security;

create policy "pools hr manage" on public.talent_pools
  for all to authenticated
  using (public.is_talent_admin(auth.uid(), organization_id))
  with check (public.is_talent_admin(auth.uid(), organization_id));

create trigger trg_talent_pools_updated_at
  before update on public.talent_pools
  for each row execute function public.update_updated_at_column();

-- ---------- 2. talent_pool_members ----------
create table if not exists public.talent_pool_members (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  pool_id uuid not null references public.talent_pools(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  readiness text check (readiness in ('ready_now','ready_1_2y','ready_3_5y','development_needed')),
  notes text,
  added_by uuid,
  added_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (pool_id, employee_id)
);
grant select, insert, update, delete on public.talent_pool_members to authenticated;
grant all on public.talent_pool_members to service_role;
alter table public.talent_pool_members enable row level security;

create policy "pool members hr manage" on public.talent_pool_members
  for all to authenticated
  using (public.is_talent_admin(auth.uid(), organization_id))
  with check (public.is_talent_admin(auth.uid(), organization_id));

create policy "pool members self read" on public.talent_pool_members
  for select to authenticated using (
    employee_id = public.current_employee_id(organization_id)
    or public.is_manager_of(auth.uid(), employee_id)
    or public.is_talent_admin(auth.uid(), organization_id)
  );

create trigger trg_talent_pool_members_updated_at
  before update on public.talent_pool_members
  for each row execute function public.update_updated_at_column();

-- Now that talent_pool_members exists, add the cross-referencing manager-read
-- policy to talent_pools.
create policy "pools managers read" on public.talent_pools
  for select to authenticated using (
    public.is_talent_admin(auth.uid(), organization_id)
    or exists (
      select 1 from public.talent_pool_members m
      where m.pool_id = talent_pools.id
        and public.is_manager_of(auth.uid(), m.employee_id)
    )
  );

-- ---------- 3. succession_plans ----------
create table if not exists public.succession_plans (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  business_id uuid,
  job_position_id uuid,
  role_title text not null,
  incumbent_employee_id uuid references public.employees(id) on delete set null,
  criticality text not null default 'high'
    check (criticality in ('low','medium','high','critical')),
  vacancy_risk text not null default 'medium'
    check (vacancy_risk in ('low','medium','high')),
  notes text,
  is_active boolean not null default true,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
grant select, insert, update, delete on public.succession_plans to authenticated;
grant all on public.succession_plans to service_role;
alter table public.succession_plans enable row level security;

create policy "succession plans hr manage" on public.succession_plans
  for all to authenticated
  using (public.is_talent_admin(auth.uid(), organization_id))
  with check (public.is_talent_admin(auth.uid(), organization_id));

create policy "succession plans incumbent read" on public.succession_plans
  for select to authenticated using (
    public.is_talent_admin(auth.uid(), organization_id)
    or (incumbent_employee_id is not null
        and incumbent_employee_id = public.current_employee_id(organization_id))
    or (incumbent_employee_id is not null
        and public.is_manager_of(auth.uid(), incumbent_employee_id))
  );

create trigger trg_succession_plans_updated_at
  before update on public.succession_plans
  for each row execute function public.update_updated_at_column();

-- ---------- 4. successors ----------
create table if not exists public.successors (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  plan_id uuid not null references public.succession_plans(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  readiness text not null default 'ready_1_2y'
    check (readiness in ('ready_now','ready_1_2y','ready_3_5y','emergency_cover')),
  rank int not null default 1 check (rank between 1 and 50),
  development_notes text,
  added_by uuid,
  added_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (plan_id, employee_id)
);
grant select, insert, update, delete on public.successors to authenticated;
grant all on public.successors to service_role;
alter table public.successors enable row level security;

create policy "successors hr manage" on public.successors
  for all to authenticated
  using (public.is_talent_admin(auth.uid(), organization_id))
  with check (public.is_talent_admin(auth.uid(), organization_id));

create policy "successors self read" on public.successors
  for select to authenticated using (
    employee_id = public.current_employee_id(organization_id)
    or public.is_manager_of(auth.uid(), employee_id)
    or public.is_talent_admin(auth.uid(), organization_id)
  );

create trigger trg_successors_updated_at
  before update on public.successors
  for each row execute function public.update_updated_at_column();

-- ---------- 5. talent_potential_ratings (9-box placements) ----------
create table if not exists public.talent_potential_ratings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  cycle_id uuid not null references public.performance_cycles(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  potential smallint not null check (potential between 1 and 3),
  performance smallint not null check (performance between 1 and 3),
  placement_reason text,
  placed_by uuid,
  placed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (cycle_id, employee_id)
);
grant select, insert, update, delete on public.talent_potential_ratings to authenticated;
grant all on public.talent_potential_ratings to service_role;
alter table public.talent_potential_ratings enable row level security;

create policy "nine box hr write" on public.talent_potential_ratings
  for all to authenticated
  using (public.is_talent_admin(auth.uid(), organization_id))
  with check (public.is_talent_admin(auth.uid(), organization_id));

create policy "nine box self read" on public.talent_potential_ratings
  for select to authenticated using (
    employee_id = public.current_employee_id(organization_id)
    or public.is_manager_of(auth.uid(), employee_id)
    or public.is_talent_admin(auth.uid(), organization_id)
  );

create trigger trg_potential_ratings_updated_at
  before update on public.talent_potential_ratings
  for each row execute function public.update_updated_at_column();

-- ---------- RPC: talent_place_on_nine_box ----------
create or replace function public.talent_place_on_nine_box(
  _employee_id uuid,
  _cycle_id uuid,
  _potential smallint,
  _placement_reason text default null,
  _performance_override smallint default null
)
returns public.talent_potential_ratings
language plpgsql security definer set search_path = public as $$
declare
  v_org uuid;
  v_perf smallint;
  v_final numeric(3,2);
  v_row public.talent_potential_ratings;
begin
  if _potential is null or _potential < 1 or _potential > 3 then
    raise exception 'potential must be between 1 and 3';
  end if;

  select organization_id into v_org
  from public.performance_cycles where id = _cycle_id;
  if v_org is null then
    raise exception 'cycle not found';
  end if;

  if not public.is_talent_admin(auth.uid(), v_org) then
    raise exception 'forbidden: HR/admin role required';
  end if;

  select pr.final_rating into v_final
  from public.performance_reviews pr
  where pr.employee_id = _employee_id
    and pr.cycle_id = _cycle_id
    and pr.signed_off_at is not null
  order by pr.signed_off_at desc
  limit 1;

  v_perf := coalesce(
    _performance_override,
    case
      when v_final is null then 2
      when v_final < 2.5 then 1
      when v_final < 4.0 then 2
      else 3
    end
  );

  insert into public.talent_potential_ratings
    (organization_id, cycle_id, employee_id, potential, performance,
     placement_reason, placed_by)
  values
    (v_org, _cycle_id, _employee_id, _potential, v_perf,
     _placement_reason, auth.uid())
  on conflict (cycle_id, employee_id) do update
    set potential        = excluded.potential,
        performance      = excluded.performance,
        placement_reason = excluded.placement_reason,
        placed_by        = excluded.placed_by,
        placed_at        = now()
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.talent_place_on_nine_box(uuid, uuid, smallint, text, smallint) from public;
grant execute on function public.talent_place_on_nine_box(uuid, uuid, smallint, text, smallint) to authenticated;

-- ---------- views for dashboards ----------
create or replace view public.v_nine_box_grid
with (security_invoker = true) as
select
  r.organization_id,
  r.cycle_id,
  r.potential,
  r.performance,
  count(*)::int as employee_count
from public.talent_potential_ratings r
group by r.organization_id, r.cycle_id, r.potential, r.performance;
grant select on public.v_nine_box_grid to authenticated;

create or replace view public.v_succession_bench_strength
with (security_invoker = true) as
select
  p.organization_id,
  p.id as plan_id,
  p.role_title,
  p.criticality,
  count(s.id)::int as successor_count,
  count(*) filter (where s.readiness = 'ready_now')::int as ready_now_count,
  count(*) filter (where s.readiness = 'ready_1_2y')::int as ready_1_2y_count,
  count(*) filter (where s.readiness = 'ready_3_5y')::int as ready_3_5y_count,
  case
    when count(*) filter (where s.readiness = 'ready_now') >= 1 then 'strong'
    when count(s.id) >= 2 then 'developing'
    when count(s.id) = 1 then 'thin'
    else 'at_risk'
  end as bench_strength
from public.succession_plans p
left join public.successors s on s.plan_id = p.id
where p.is_active = true
group by p.organization_id, p.id, p.role_title, p.criticality;
grant select on public.v_succession_bench_strength to authenticated;

-- ---------- audit triggers ----------
drop trigger if exists trg_audit_talent_pools on public.talent_pools;
create trigger trg_audit_talent_pools
  after insert or update or delete on public.talent_pools
  for each row execute function public._talent_audit_trigger();

drop trigger if exists trg_audit_talent_pool_members on public.talent_pool_members;
create trigger trg_audit_talent_pool_members
  after insert or update or delete on public.talent_pool_members
  for each row execute function public._talent_audit_trigger();

drop trigger if exists trg_audit_succession_plans on public.succession_plans;
create trigger trg_audit_succession_plans
  after insert or update or delete on public.succession_plans
  for each row execute function public._talent_audit_trigger();

drop trigger if exists trg_audit_successors on public.successors;
create trigger trg_audit_successors
  after insert or update or delete on public.successors
  for each row execute function public._talent_audit_trigger();

drop trigger if exists trg_audit_potential_ratings on public.talent_potential_ratings;
create trigger trg_audit_potential_ratings
  after insert or update or delete on public.talent_potential_ratings
  for each row execute function public._talent_audit_trigger();

-- ---------- indexes ----------
create index if not exists idx_talent_pool_members_pool on public.talent_pool_members(pool_id);
create index if not exists idx_talent_pool_members_employee on public.talent_pool_members(employee_id);
create index if not exists idx_successors_plan on public.successors(plan_id);
create index if not exists idx_successors_employee on public.successors(employee_id);
create index if not exists idx_potential_cycle on public.talent_potential_ratings(cycle_id);
create index if not exists idx_potential_employee on public.talent_potential_ratings(employee_id);
create index if not exists idx_succession_plans_position on public.succession_plans(job_position_id);
