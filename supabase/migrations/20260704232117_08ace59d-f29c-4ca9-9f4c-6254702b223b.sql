
-- ================================================================
-- Talent Phase 6 + Phase 7 tail
-- ================================================================

-- ---------- 1. talent_settings -----------------------------------
create table if not exists public.talent_settings (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  default_review_scale_min int not null default 1 check (default_review_scale_min between 1 and 10),
  default_review_scale_max int not null default 5 check (default_review_scale_max between 1 and 10),
  default_competency_scale_id uuid references public.competency_scales(id) on delete set null,
  merit_requires_approval boolean not null default true,
  calibration_requires_approval boolean not null default false,
  devplan_activation_requires_approval boolean not null default false,
  goal_checkin_reminder_days int not null default 0 check (goal_checkin_reminder_days between 0 and 30),
  oneonone_reminder_hours int not null default 24 check (oneonone_reminder_hours between 1 and 168),
  action_item_reminder_days int not null default 1 check (action_item_reminder_days between 0 and 30),
  hipo_potential_threshold int not null default 3 check (hipo_potential_threshold between 1 and 3),
  hipo_performance_threshold int not null default 3 check (hipo_performance_threshold between 1 and 3),
  require_manager_ack_on_review boolean not null default true,
  auto_close_cycles boolean not null default false,
  updated_by uuid,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  check (default_review_scale_max >= default_review_scale_min)
);
grant select, insert, update on public.talent_settings to authenticated;
grant all on public.talent_settings to service_role;
alter table public.talent_settings enable row level security;

create policy "talent_settings org read" on public.talent_settings
  for select to authenticated
  using (organization_id = any(get_user_organization_ids()));

-- Write gated to admin/owner via has_role(uuid,text) overload.
create policy "talent_settings admin write" on public.talent_settings
  for all to authenticated
  using (
    organization_id = any(get_user_organization_ids())
    and (
      public.has_role(auth.uid(), 'admin')
      or public.has_role(auth.uid(), 'owner')
      or public.has_role(auth.uid(), 'super_admin')
    )
  )
  with check (
    organization_id = any(get_user_organization_ids())
    and (
      public.has_role(auth.uid(), 'admin')
      or public.has_role(auth.uid(), 'owner')
      or public.has_role(auth.uid(), 'super_admin')
    )
  );

create trigger trg_talent_settings_updated_at
  before update on public.talent_settings
  for each row execute function public.update_updated_at_column();

insert into public.talent_settings (organization_id)
  select id from public.organizations
  on conflict (organization_id) do nothing;

create or replace function public._talent_settings_seed()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.talent_settings (organization_id)
    values (new.id)
    on conflict (organization_id) do nothing;
  return new;
end;
$$;
drop trigger if exists trg_organizations_talent_settings_seed on public.organizations;
create trigger trg_organizations_talent_settings_seed
  after insert on public.organizations
  for each row execute function public._talent_settings_seed();

-- ---------- 2. oneonone_action_items ----------------------------
create table if not exists public.oneonone_action_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  one_on_one_id uuid not null references public.one_on_ones(id) on delete cascade,
  text text not null,
  owner text not null check (owner in ('manager','employee')),
  due_date date,
  status text not null default 'open' check (status in ('open','done','cancelled')),
  completed_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
grant select, insert, update, delete on public.oneonone_action_items to authenticated;
grant all on public.oneonone_action_items to service_role;
alter table public.oneonone_action_items enable row level security;

create policy "oneonone_ai participants read" on public.oneonone_action_items
  for select to authenticated
  using (
    exists (
      select 1 from public.one_on_ones o
      where o.id = oneonone_action_items.one_on_one_id
        and (
          o.employee_id = public.current_employee_id(o.organization_id)
          or o.manager_id = public.current_employee_id(o.organization_id)
          or public.is_manager_of(auth.uid(), o.employee_id)
        )
    )
  );
create policy "oneonone_ai participants write" on public.oneonone_action_items
  for all to authenticated
  using (
    exists (
      select 1 from public.one_on_ones o
      where o.id = oneonone_action_items.one_on_one_id
        and (
          o.employee_id = public.current_employee_id(o.organization_id)
          or o.manager_id = public.current_employee_id(o.organization_id)
          or public.is_manager_of(auth.uid(), o.employee_id)
        )
    )
  )
  with check (
    exists (
      select 1 from public.one_on_ones o
      where o.id = oneonone_action_items.one_on_one_id
        and (
          o.employee_id = public.current_employee_id(o.organization_id)
          or o.manager_id = public.current_employee_id(o.organization_id)
          or public.is_manager_of(auth.uid(), o.employee_id)
        )
    )
  );

create index if not exists idx_oneonone_ai_meeting on public.oneonone_action_items(one_on_one_id);
create index if not exists idx_oneonone_ai_open_due
  on public.oneonone_action_items(due_date) where status = 'open';

create trigger trg_oneonone_ai_updated_at
  before update on public.oneonone_action_items
  for each row execute function public.update_updated_at_column();

-- Backfill from existing JSONB action_items.
insert into public.oneonone_action_items
  (organization_id, one_on_one_id, text, owner, due_date, status, created_at)
select
  o.organization_id,
  o.id,
  coalesce(item->>'text', ''),
  case when (item->>'owner') in ('manager','employee') then item->>'owner' else 'manager' end,
  nullif(item->>'due','')::date,
  case when (item->>'done')::boolean = true then 'done' else 'open' end,
  o.created_at
from public.one_on_ones o
cross join lateral jsonb_array_elements(coalesce(o.action_items, '[]'::jsonb)) as item
where jsonb_typeof(o.action_items) = 'array'
  and coalesce(item->>'text','') <> ''
  and not exists (
    select 1 from public.oneonone_action_items ai where ai.one_on_one_id = o.id
  );

-- ---------- 3. Competency scale seed ---------------------------
insert into public.competency_scales (organization_id, name, is_default, levels)
select
  o.id,
  'Standard 5-point',
  true,
  '[{"level":1,"label":"Novice"},{"level":2,"label":"Developing"},{"level":3,"label":"Proficient"},{"level":4,"label":"Advanced"},{"level":5,"label":"Expert"}]'::jsonb
from public.organizations o
where not exists (
  select 1 from public.competency_scales cs where cs.organization_id = o.id
);

update public.talent_settings ts
set default_competency_scale_id = cs.id
from public.competency_scales cs
where cs.organization_id = ts.organization_id
  and cs.is_default = true
  and ts.default_competency_scale_id is null;

create or replace function public._competency_scale_seed()
returns trigger language plpgsql security definer set search_path = public as $$
declare _scale_id uuid;
begin
  insert into public.competency_scales (organization_id, name, is_default, levels)
    values (
      new.id,
      'Standard 5-point',
      true,
      '[{"level":1,"label":"Novice"},{"level":2,"label":"Developing"},{"level":3,"label":"Proficient"},{"level":4,"label":"Advanced"},{"level":5,"label":"Expert"}]'::jsonb
    )
    returning id into _scale_id;

  update public.talent_settings
    set default_competency_scale_id = _scale_id
    where organization_id = new.id
      and default_competency_scale_id is null;
  return new;
exception when others then
  return new;
end;
$$;
drop trigger if exists trg_organizations_competency_scale_seed on public.organizations;
create trigger trg_organizations_competency_scale_seed
  after insert on public.organizations
  for each row execute function public._competency_scale_seed();

-- ---------- 4. Extend due-notification emitter ------------------
create or replace function public.talent_emit_due_notifications()
returns int language plpgsql security definer set search_path = public as $$
declare
  _n int := 0;
  _r record;
begin
  -- Goals: check-in due
  for _r in
    select g.id, g.title, g.organization_id, g.employee_id, e.user_id
    from public.performance_goals g
    join public.v_employees_canonical e on e.id = g.employee_id
    where g.next_check_in_due_at is not null
      and g.next_check_in_due_at <= now()
      and coalesce(g.status::text,'') not in ('done','cancelled','archived')
      and e.user_id is not null
      and not exists (
        select 1 from public.notifications n
        where n.user_id = e.user_id
          and n.entity_type = 'performance_goal'
          and n.entity_id = g.id
          and n.category = 'talent'
          and n.title = 'Goal check-in due'
          and n.created_at > now() - interval '20 hours'
      )
  loop
    perform public._talent_notify(
      _r.organization_id, null, _r.user_id,
      'goal.checkin_due', 'Goal check-in due',
      format('Your goal "%s" is due for a check-in.', _r.title),
      format('/me/talent/goals/%s', _r.id),
      'performance_goal', _r.id, 3);
    _n := _n + 1;
  end loop;

  -- 1-on-1s: honor per-org reminder window (default 24h)
  for _r in
    select o.id, o.organization_id, o.scheduled_at,
           em.user_id as emp_user, mm.user_id as mgr_user
    from public.one_on_ones o
    join public.v_employees_canonical em on em.id = o.employee_id
    join public.v_employees_canonical mm on mm.id = o.manager_id
    left join public.talent_settings ts on ts.organization_id = o.organization_id
    where coalesce(o.status, 'scheduled') = 'scheduled'
      and o.scheduled_at between now()
                             and now() + make_interval(hours => coalesce(ts.oneonone_reminder_hours, 24))
      and not exists (
        select 1 from public.notifications n
        where n.entity_type = 'one_on_one' and n.entity_id = o.id
          and n.category = 'talent' and n.title = '1-on-1 reminder'
          and n.created_at > now() - interval '20 hours'
      )
  loop
    perform public._talent_notify(_r.organization_id, null, _r.emp_user,
      'oneonone.reminder', '1-on-1 reminder',
      format('Your 1-on-1 is scheduled for %s.', to_char(_r.scheduled_at, 'YYYY-MM-DD HH24:MI')),
      '/me/talent/one-on-ones', 'one_on_one', _r.id, 3);
    perform public._talent_notify(_r.organization_id, null, _r.mgr_user,
      'oneonone.reminder', '1-on-1 reminder',
      format('Your 1-on-1 is scheduled for %s.', to_char(_r.scheduled_at, 'YYYY-MM-DD HH24:MI')),
      '/hr/talent/one-on-ones', 'one_on_one', _r.id, 3);
    _n := _n + 2;
  end loop;

  -- Action item reminders
  for _r in
    select ai.id, ai.text, ai.due_date, ai.owner, ai.one_on_one_id,
           o.organization_id, o.employee_id, o.manager_id,
           case when ai.owner = 'employee' then em.user_id else mm.user_id end as target_user
    from public.oneonone_action_items ai
    join public.one_on_ones o on o.id = ai.one_on_one_id
    join public.v_employees_canonical em on em.id = o.employee_id
    join public.v_employees_canonical mm on mm.id = o.manager_id
    left join public.talent_settings ts on ts.organization_id = o.organization_id
    where ai.status = 'open'
      and ai.due_date is not null
      and ai.due_date <= (current_date + coalesce(ts.action_item_reminder_days, 1))
      and not exists (
        select 1 from public.notifications n
        where n.entity_type = 'oneonone_action_item'
          and n.entity_id = ai.id
          and n.category = 'talent'
          and n.title = 'Action item due'
          and n.created_at > now() - interval '20 hours'
      )
  loop
    perform public._talent_notify(
      _r.organization_id, null, _r.target_user,
      'oneonone.action_item', 'Action item due',
      format('Action item due %s: %s',
             to_char(_r.due_date, 'YYYY-MM-DD'),
             left(_r.text, 100)),
      '/me/talent/one-on-ones',
      'oneonone_action_item', _r.id, 3);
    _n := _n + 1;
  end loop;

  return _n;
end;
$$;
revoke all on function public.talent_emit_due_notifications() from public;
grant execute on function public.talent_emit_due_notifications() to service_role;
