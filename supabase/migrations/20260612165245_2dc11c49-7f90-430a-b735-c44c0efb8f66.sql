-- =====================================================================
-- Phase A — Continuous Performance: 1:1s, Continuous Feedback, Kudos
-- =====================================================================
-- Builds on existing helpers: current_employee_id(org), is_manager_of(uid, emp_id),
-- update_updated_at_column(). Follows the project's CREATE TABLE → GRANT →
-- ENABLE RLS → CREATE POLICY ordering.
-- =====================================================================

-- ---------- 1. one_on_ones ----------
create table if not exists public.one_on_ones (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  business_id uuid,
  manager_id uuid not null references public.employees(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  scheduled_at timestamptz not null,
  duration_minutes int not null default 30 check (duration_minutes between 5 and 480),
  status text not null default 'scheduled'
    check (status in ('scheduled','completed','cancelled','no_show')),
  recurrence text check (recurrence in ('none','weekly','biweekly','monthly')),
  shared_summary text,
  private_notes_manager text,
  private_notes_employee text,
  action_items jsonb not null default '[]'::jsonb,
  completed_at timestamptz,
  cancelled_reason text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
grant select, insert, update, delete on public.one_on_ones to authenticated;
grant all on public.one_on_ones to service_role;
alter table public.one_on_ones enable row level security;

create policy "1on1 participants read" on public.one_on_ones
  for select to authenticated using (
    employee_id = public.current_employee_id(organization_id)
    or manager_id = public.current_employee_id(organization_id)
    or public.is_manager_of(auth.uid(), employee_id)
  );
create policy "1on1 participants write" on public.one_on_ones
  for all to authenticated
  using (
    employee_id = public.current_employee_id(organization_id)
    or manager_id = public.current_employee_id(organization_id)
    or public.is_manager_of(auth.uid(), employee_id)
  )
  with check (
    employee_id = public.current_employee_id(organization_id)
    or manager_id = public.current_employee_id(organization_id)
    or public.is_manager_of(auth.uid(), employee_id)
  );

create index if not exists idx_1on1_employee on public.one_on_ones(employee_id, scheduled_at desc);
create index if not exists idx_1on1_manager  on public.one_on_ones(manager_id,  scheduled_at desc);

create trigger trg_1on1_updated_at
  before update on public.one_on_ones
  for each row execute function public.update_updated_at_column();

-- Column-masking via a view: each side reads their own private notes only.
create or replace view public.one_on_ones_visible
with (security_invoker = true)
as
select
  o.id, o.organization_id, o.business_id,
  o.manager_id, o.employee_id, o.scheduled_at, o.duration_minutes,
  o.status, o.recurrence, o.shared_summary, o.action_items,
  o.completed_at, o.cancelled_reason, o.created_by, o.created_at, o.updated_at,
  case
    when o.manager_id = public.current_employee_id(o.organization_id)
      or public.is_manager_of(auth.uid(), o.employee_id)
    then o.private_notes_manager
    else null
  end as private_notes_manager,
  case
    when o.employee_id = public.current_employee_id(o.organization_id)
    then o.private_notes_employee
    else null
  end as private_notes_employee
from public.one_on_ones o;
grant select on public.one_on_ones_visible to authenticated;

-- ---------- 2. one_on_one_talking_points ----------
create table if not exists public.one_on_one_talking_points (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  one_on_one_id uuid not null references public.one_on_ones(id) on delete cascade,
  author_role text not null check (author_role in ('manager','employee')),
  author_user_id uuid,
  body text not null,
  is_addressed boolean not null default false,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);
grant select, insert, update, delete on public.one_on_one_talking_points to authenticated;
grant all on public.one_on_one_talking_points to service_role;
alter table public.one_on_one_talking_points enable row level security;

create policy "1on1 tp read"  on public.one_on_one_talking_points
  for select to authenticated using (
    exists (select 1 from public.one_on_ones o
      where o.id = one_on_one_id
        and (o.employee_id = public.current_employee_id(o.organization_id)
          or o.manager_id  = public.current_employee_id(o.organization_id)
          or public.is_manager_of(auth.uid(), o.employee_id)))
  );
create policy "1on1 tp write" on public.one_on_one_talking_points
  for all to authenticated
  using (
    exists (select 1 from public.one_on_ones o
      where o.id = one_on_one_id
        and (o.employee_id = public.current_employee_id(o.organization_id)
          or o.manager_id  = public.current_employee_id(o.organization_id)
          or public.is_manager_of(auth.uid(), o.employee_id)))
  )
  with check (
    exists (select 1 from public.one_on_ones o
      where o.id = one_on_one_id
        and (o.employee_id = public.current_employee_id(o.organization_id)
          or o.manager_id  = public.current_employee_id(o.organization_id)
          or public.is_manager_of(auth.uid(), o.employee_id)))
  );

create index if not exists idx_1on1_tp_meeting on public.one_on_one_talking_points(one_on_one_id, sort_order);

-- ---------- 3. continuous_feedback ----------
create table if not exists public.continuous_feedback (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  business_id uuid,
  from_user_id uuid not null,
  from_employee_id uuid references public.employees(id) on delete set null,
  to_employee_id uuid not null references public.employees(id) on delete cascade,
  feedback_type text not null check (feedback_type in ('praise','constructive','request')),
  visibility text not null default 'private' check (visibility in ('private','manager','public')),
  body text not null,
  competency_id uuid references public.competencies(id) on delete set null,
  goal_id uuid references public.performance_goals(id) on delete set null,
  is_anonymous boolean not null default false,
  acknowledged_at timestamptz,
  acknowledged_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
grant select, insert, update, delete on public.continuous_feedback to authenticated;
grant all on public.continuous_feedback to service_role;
alter table public.continuous_feedback enable row level security;

create policy "feedback receiver read" on public.continuous_feedback
  for select to authenticated using (
    -- receiver always sees their own feedback
    to_employee_id = public.current_employee_id(organization_id)
    -- author always sees what they wrote
    or from_user_id = auth.uid()
    -- manager sees when shared
    or (visibility in ('manager','public') and public.is_manager_of(auth.uid(), to_employee_id))
    -- whole org sees public
    or visibility = 'public'
  );

create policy "feedback author insert" on public.continuous_feedback
  for insert to authenticated with check (
    from_user_id = auth.uid()
    and to_employee_id <> coalesce(public.current_employee_id(organization_id), '00000000-0000-0000-0000-000000000000'::uuid)
  );

-- Author can edit/delete their own feedback within 24h. After that it's locked.
create policy "feedback author edit window" on public.continuous_feedback
  for update to authenticated using (
    from_user_id = auth.uid()
    and created_at > now() - interval '24 hours'
  ) with check (
    from_user_id = auth.uid()
    and created_at > now() - interval '24 hours'
  );

create policy "feedback author delete window" on public.continuous_feedback
  for delete to authenticated using (
    from_user_id = auth.uid()
    and created_at > now() - interval '24 hours'
  );

create index if not exists idx_feedback_to   on public.continuous_feedback(to_employee_id, created_at desc);
create index if not exists idx_feedback_from on public.continuous_feedback(from_user_id, created_at desc);

create trigger trg_feedback_updated_at
  before update on public.continuous_feedback
  for each row execute function public.update_updated_at_column();

-- ---------- 4. kudos ----------
create table if not exists public.kudos (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  business_id uuid,
  from_user_id uuid not null,
  from_employee_id uuid references public.employees(id) on delete set null,
  to_employee_id uuid not null references public.employees(id) on delete cascade,
  body text not null,
  value_tag text,
  reaction_count int not null default 0,
  created_at timestamptz not null default now()
);
grant select, insert, update, delete on public.kudos to authenticated;
grant all on public.kudos to service_role;
alter table public.kudos enable row level security;

create policy "kudos org read"    on public.kudos for select to authenticated using (true);
create policy "kudos author send" on public.kudos for insert to authenticated
  with check (from_user_id = auth.uid()
              and to_employee_id <> coalesce(public.current_employee_id(organization_id), '00000000-0000-0000-0000-000000000000'::uuid));
create policy "kudos author edit" on public.kudos for update to authenticated
  using (from_user_id = auth.uid() and created_at > now() - interval '24 hours')
  with check (from_user_id = auth.uid() and created_at > now() - interval '24 hours');
create policy "kudos author delete" on public.kudos for delete to authenticated
  using (from_user_id = auth.uid() and created_at > now() - interval '24 hours');

create index if not exists idx_kudos_to on public.kudos(to_employee_id, created_at desc);

-- ---------- 5. Audit triggers ----------
create or replace function public._talent_audit_trigger()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_action text;
  v_record jsonb;
begin
  v_action := lower(tg_op);
  v_record := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  insert into public.audit_logs (
    organization_id, user_id, action, resource_type, resource_id, new_values
  ) values (
    coalesce((v_record->>'organization_id')::uuid, null),
    auth.uid(),
    v_action,
    tg_table_name,
    coalesce((v_record->>'id')::uuid, null),
    v_record
  );
  return case when tg_op = 'DELETE' then old else new end;
exception when others then
  -- never block the user-facing write because of an audit failure
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists trg_audit_feedback on public.continuous_feedback;
create trigger trg_audit_feedback
  after insert or update or delete on public.continuous_feedback
  for each row execute function public._talent_audit_trigger();

drop trigger if exists trg_audit_kudos on public.kudos;
create trigger trg_audit_kudos
  after insert or update or delete on public.kudos
  for each row execute function public._talent_audit_trigger();

drop trigger if exists trg_audit_1on1 on public.one_on_ones;
create trigger trg_audit_1on1
  after insert or update or delete on public.one_on_ones
  for each row execute function public._talent_audit_trigger();
