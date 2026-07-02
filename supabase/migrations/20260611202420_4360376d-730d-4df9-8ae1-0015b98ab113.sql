
-- =====================================================================
-- TALENT MANAGEMENT — Phase 1 foundation (additive, backwards compatible)
-- =====================================================================
-- Strategy:
--   * Extend performance_cycles / performance_goals with the columns a real
--     lifecycle needs (phase windows, weights, alignment, parent goals).
--   * Add new tables for goal milestones + updates, competency proficiency
--     scales + role requirements + cycle-based assessments, review
--     templates + participants + responses + ratings, and development
--     plans + items.
--   * Add an `is_manager_of` security-definer helper for RLS that lets
--     managers see (only) their reports' talent records.
--   * RLS on every new table; GRANTs to authenticated + service_role.
--   * updated_at triggers reuse the existing public.update_updated_at_column.
-- All existing tables / rows / policies are preserved.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. Helpers
-- ---------------------------------------------------------------------

-- Manager → report graph helper. Walks employees.manager_id up to 6 levels.
-- Used by RLS so a manager can read their (in)direct reports' talent rows
-- without recursive policy lookups on the employees table.
create or replace function public.is_manager_of(_manager_user_id uuid, _employee_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  with recursive chain as (
    select e.id, e.manager_id, 1 as depth
    from public.employees e
    where e.id = _employee_id
    union all
    select e2.id, e2.manager_id, c.depth + 1
    from public.employees e2
    join chain c on e2.id = c.manager_id
    where c.depth < 6
  )
  select exists (
    select 1
    from chain c
    join public.employees m on m.id = c.manager_id
    where m.user_id = _manager_user_id
  )
$$;

-- Find the current user's employee id within an org (used by employee-self policies).
create or replace function public.current_employee_id(_organization_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select e.id
  from public.employees e
  where e.user_id = auth.uid()
    and e.organization_id = _organization_id
  limit 1
$$;

-- ---------------------------------------------------------------------
-- 1. Performance Cycles — extend with lifecycle phase windows
-- ---------------------------------------------------------------------
alter table public.performance_cycles
  add column if not exists phase text not null default 'planning'
    check (phase in ('planning','goal_setting','in_progress','self_review','manager_review','peer_review','calibration','sign_off','closed')),
  add column if not exists goal_setting_open_at timestamptz,
  add column if not exists goal_setting_due_at  timestamptz,
  add column if not exists self_review_open_at  timestamptz,
  add column if not exists self_review_due_at   timestamptz,
  add column if not exists manager_review_open_at timestamptz,
  add column if not exists manager_review_due_at  timestamptz,
  add column if not exists peer_review_open_at  timestamptz,
  add column if not exists peer_review_due_at   timestamptz,
  add column if not exists calibration_open_at  timestamptz,
  add column if not exists sign_off_due_at      timestamptz,
  add column if not exists default_template_id  uuid,
  add column if not exists scope text not null default 'organization'
    check (scope in ('organization','department','custom')),
  add column if not exists scope_department_ids uuid[] default '{}'::uuid[];

-- ---------------------------------------------------------------------
-- 2. Performance Goals — weights, alignment, parent linkage, measurement
-- ---------------------------------------------------------------------
alter table public.performance_goals
  add column if not exists parent_goal_id uuid references public.performance_goals(id) on delete set null,
  add column if not exists weight numeric(5,2) not null default 100 check (weight >= 0 and weight <= 100),
  add column if not exists alignment text not null default 'individual'
    check (alignment in ('organization','department','team','individual')),
  add column if not exists measurement_type text not null default 'percent'
    check (measurement_type in ('percent','number','currency','boolean','milestone')),
  add column if not exists target_value numeric(18,4),
  add column if not exists current_value numeric(18,4),
  add column if not exists unit text,
  add column if not exists category text,
  add column if not exists assigned_by uuid,
  add column if not exists assigned_at timestamptz,
  add column if not exists last_check_in_at timestamptz,
  add column if not exists next_check_in_due_at timestamptz,
  add column if not exists manager_comment text,
  add column if not exists final_rating numeric(3,2);

create index if not exists idx_perf_goals_cycle on public.performance_goals(cycle_id);
create index if not exists idx_perf_goals_employee on public.performance_goals(employee_id);
create index if not exists idx_perf_goals_parent on public.performance_goals(parent_goal_id);

-- ---------------------------------------------------------------------
-- 3. Goal milestones + goal updates (richer than existing goal_check_ins,
--    which we keep for back-compat reads).
-- ---------------------------------------------------------------------
create table if not exists public.goal_milestones (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  goal_id uuid not null references public.performance_goals(id) on delete cascade,
  title text not null,
  due_date date,
  weight numeric(5,2) not null default 0 check (weight >= 0 and weight <= 100),
  status text not null default 'pending' check (status in ('pending','in_progress','done','skipped')),
  sort_order int not null default 0,
  completed_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
grant select, insert, update, delete on public.goal_milestones to authenticated;
grant all on public.goal_milestones to service_role;
alter table public.goal_milestones enable row level security;

create policy "goal_milestones org read" on public.goal_milestones
  for select to authenticated
  using (
    exists (select 1 from public.performance_goals g
            where g.id = goal_milestones.goal_id
              and g.organization_id = goal_milestones.organization_id)
  );
create policy "goal_milestones manager write" on public.goal_milestones
  for all to authenticated
  using (
    exists (select 1 from public.performance_goals g
            where g.id = goal_milestones.goal_id
              and (
                g.employee_id = public.current_employee_id(g.organization_id)
                or public.is_manager_of(auth.uid(), g.employee_id)
              ))
  )
  with check (
    exists (select 1 from public.performance_goals g
            where g.id = goal_milestones.goal_id
              and (
                g.employee_id = public.current_employee_id(g.organization_id)
                or public.is_manager_of(auth.uid(), g.employee_id)
              ))
  );

create table if not exists public.goal_updates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  goal_id uuid not null references public.performance_goals(id) on delete cascade,
  milestone_id uuid references public.goal_milestones(id) on delete set null,
  update_type text not null default 'check_in'
    check (update_type in ('check_in','manager_feedback','blocker','milestone_completed','status_change','rating')),
  author_user_id uuid,
  author_role text check (author_role in ('employee','manager','hr','system')),
  progress_pct numeric(5,2),
  status_to text,
  comment text,
  created_at timestamptz not null default now()
);
grant select, insert on public.goal_updates to authenticated;
grant all on public.goal_updates to service_role;
alter table public.goal_updates enable row level security;

create policy "goal_updates org read" on public.goal_updates
  for select to authenticated
  using (
    exists (select 1 from public.performance_goals g
            where g.id = goal_updates.goal_id
              and (
                g.employee_id = public.current_employee_id(g.organization_id)
                or public.is_manager_of(auth.uid(), g.employee_id)
              ))
  );
create policy "goal_updates insert" on public.goal_updates
  for insert to authenticated
  with check (
    exists (select 1 from public.performance_goals g
            where g.id = goal_updates.goal_id
              and (
                g.employee_id = public.current_employee_id(g.organization_id)
                or public.is_manager_of(auth.uid(), g.employee_id)
              ))
  );

create index if not exists idx_goal_updates_goal on public.goal_updates(goal_id, created_at desc);
create index if not exists idx_goal_milestones_goal on public.goal_milestones(goal_id, sort_order);

-- ---------------------------------------------------------------------
-- 4. Competency proficiency scales + role requirements + cycle assessments
-- ---------------------------------------------------------------------
create table if not exists public.competency_scales (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  name text not null,
  is_default boolean not null default false,
  levels jsonb not null default
    '[{"level":1,"label":"Novice"},{"level":2,"label":"Beginner"},{"level":3,"label":"Proficient"},{"level":4,"label":"Advanced"},{"level":5,"label":"Expert"}]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
grant select on public.competency_scales to authenticated;
grant insert, update, delete on public.competency_scales to authenticated;
grant all on public.competency_scales to service_role;
alter table public.competency_scales enable row level security;
create policy "competency_scales org read"  on public.competency_scales for select to authenticated using (true);
create policy "competency_scales org write" on public.competency_scales for all    to authenticated using (true) with check (true);

-- Extend competencies with proficiency scale + ownership metadata.
alter table public.competencies
  add column if not exists scale_id uuid references public.competency_scales(id) on delete set null,
  add column if not exists is_core boolean not null default false,
  add column if not exists owner_department_id uuid references public.departments(id) on delete set null;

-- Required competency per role (job_position) and/or department.
create table if not exists public.competency_role_requirements (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  competency_id uuid not null references public.competencies(id) on delete cascade,
  job_position_id uuid references public.job_positions(id) on delete cascade,
  department_id   uuid references public.departments(id)   on delete cascade,
  required_level smallint not null check (required_level between 1 and 5),
  is_critical boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (job_position_id is not null or department_id is not null),
  unique (competency_id, job_position_id, department_id)
);
grant select, insert, update, delete on public.competency_role_requirements to authenticated;
grant all on public.competency_role_requirements to service_role;
alter table public.competency_role_requirements enable row level security;
create policy "comp_role_req read"  on public.competency_role_requirements for select to authenticated using (true);
create policy "comp_role_req write" on public.competency_role_requirements for all    to authenticated using (true) with check (true);

-- Cycle-based competency assessments (separate from the back-compat
-- `employee_competencies` table, which we leave untouched).
create table if not exists public.competency_assessments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  cycle_id uuid references public.performance_cycles(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  competency_id uuid not null references public.competencies(id) on delete cascade,
  required_level smallint check (required_level between 1 and 5),
  self_level smallint check (self_level between 1 and 5),
  manager_level smallint check (manager_level between 1 and 5),
  final_level smallint check (final_level between 1 and 5),
  self_comment text,
  manager_comment text,
  status text not null default 'pending'
    check (status in ('pending','self_done','manager_done','final')),
  assessed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (cycle_id, employee_id, competency_id)
);
grant select, insert, update, delete on public.competency_assessments to authenticated;
grant all on public.competency_assessments to service_role;
alter table public.competency_assessments enable row level security;

create policy "comp_assess self/manager read" on public.competency_assessments
  for select to authenticated
  using (
    employee_id = public.current_employee_id(organization_id)
    or public.is_manager_of(auth.uid(), employee_id)
  );
create policy "comp_assess self/manager write" on public.competency_assessments
  for all to authenticated
  using (
    employee_id = public.current_employee_id(organization_id)
    or public.is_manager_of(auth.uid(), employee_id)
  )
  with check (
    employee_id = public.current_employee_id(organization_id)
    or public.is_manager_of(auth.uid(), employee_id)
  );

create index if not exists idx_comp_assess_emp on public.competency_assessments(employee_id);
create index if not exists idx_comp_assess_cycle on public.competency_assessments(cycle_id);

-- ---------------------------------------------------------------------
-- 5. Review templates (reusable, versioned per job-family / cycle).
-- ---------------------------------------------------------------------
create table if not exists public.review_templates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  name text not null,
  description text,
  rating_scale jsonb not null default
    '[{"value":1,"label":"Below expectations"},{"value":2,"label":"Developing"},{"value":3,"label":"Meets expectations"},{"value":4,"label":"Exceeds"},{"value":5,"label":"Outstanding"}]'::jsonb,
  includes_self boolean not null default true,
  includes_manager boolean not null default true,
  includes_peer boolean not null default false,
  includes_skip_level boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
grant select, insert, update, delete on public.review_templates to authenticated;
grant all on public.review_templates to service_role;
alter table public.review_templates enable row level security;
create policy "review_templates org read"  on public.review_templates for select to authenticated using (true);
create policy "review_templates org write" on public.review_templates for all    to authenticated using (true) with check (true);

create table if not exists public.review_template_sections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  template_id uuid not null references public.review_templates(id) on delete cascade,
  title text not null,
  description text,
  sort_order int not null default 0,
  weight numeric(5,2) not null default 0,
  created_at timestamptz not null default now()
);
grant select, insert, update, delete on public.review_template_sections to authenticated;
grant all on public.review_template_sections to service_role;
alter table public.review_template_sections enable row level security;
create policy "rts read"  on public.review_template_sections for select to authenticated using (true);
create policy "rts write" on public.review_template_sections for all    to authenticated using (true) with check (true);

create table if not exists public.review_template_questions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  template_id uuid not null references public.review_templates(id) on delete cascade,
  section_id uuid references public.review_template_sections(id) on delete cascade,
  prompt text not null,
  question_type text not null default 'rating_and_comment'
    check (question_type in ('rating','comment','rating_and_comment','goal_review','competency_review')),
  competency_id uuid references public.competencies(id) on delete set null,
  is_required boolean not null default true,
  audiences text[] not null default array['self','manager']::text[],
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);
grant select, insert, update, delete on public.review_template_questions to authenticated;
grant all on public.review_template_questions to service_role;
alter table public.review_template_questions enable row level security;
create policy "rtq read"  on public.review_template_questions for select to authenticated using (true);
create policy "rtq write" on public.review_template_questions for all    to authenticated using (true) with check (true);

-- Extend performance_reviews to support templated multi-participant flow.
alter table public.performance_reviews
  add column if not exists template_id uuid references public.review_templates(id) on delete set null,
  add column if not exists review_type text not null default 'manager'
    check (review_type in ('self','manager','peer','skip_level','final')),
  add column if not exists due_at timestamptz,
  add column if not exists acknowledged_at timestamptz,
  add column if not exists final_rating numeric(3,2),
  add column if not exists calibration_notes text,
  add column if not exists signed_off_by uuid,
  add column if not exists signed_off_at timestamptz;

create index if not exists idx_perf_reviews_cycle_emp on public.performance_reviews(cycle_id, employee_id);

-- Per-review participants (self, manager, peers, skip-level).
create table if not exists public.review_participants (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  cycle_id uuid not null references public.performance_cycles(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,  -- the reviewee
  participant_user_id uuid not null,                                            -- the reviewer (auth.users.id)
  participant_employee_id uuid references public.employees(id) on delete set null,
  role text not null check (role in ('self','manager','peer','skip_level')),
  status text not null default 'invited' check (status in ('invited','in_progress','submitted','declined')),
  review_id uuid references public.performance_reviews(id) on delete set null,
  invited_at timestamptz not null default now(),
  submitted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (cycle_id, employee_id, participant_user_id, role)
);
grant select, insert, update, delete on public.review_participants to authenticated;
grant all on public.review_participants to service_role;
alter table public.review_participants enable row level security;
create policy "review_participants visible" on public.review_participants
  for select to authenticated
  using (
    participant_user_id = auth.uid()
    or employee_id = public.current_employee_id(organization_id)
    or public.is_manager_of(auth.uid(), employee_id)
  );
create policy "review_participants self update" on public.review_participants
  for update to authenticated
  using (participant_user_id = auth.uid())
  with check (participant_user_id = auth.uid());
create policy "review_participants org insert" on public.review_participants
  for insert to authenticated with check (true);

-- Per-question responses.
create table if not exists public.review_responses (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  review_id uuid not null references public.performance_reviews(id) on delete cascade,
  question_id uuid references public.review_template_questions(id) on delete set null,
  competency_id uuid references public.competencies(id) on delete set null,
  goal_id uuid references public.performance_goals(id) on delete set null,
  rating numeric(3,2),
  comment text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
grant select, insert, update, delete on public.review_responses to authenticated;
grant all on public.review_responses to service_role;
alter table public.review_responses enable row level security;
create policy "review_responses visible" on public.review_responses
  for select to authenticated
  using (
    exists (
      select 1 from public.performance_reviews r
      where r.id = review_responses.review_id
        and (
          r.reviewer_user_id = auth.uid()
          or r.employee_id = public.current_employee_id(r.organization_id)
          or public.is_manager_of(auth.uid(), r.employee_id)
        )
    )
  );
create policy "review_responses reviewer write" on public.review_responses
  for all to authenticated
  using (
    exists (select 1 from public.performance_reviews r
            where r.id = review_responses.review_id and r.reviewer_user_id = auth.uid())
  )
  with check (
    exists (select 1 from public.performance_reviews r
            where r.id = review_responses.review_id and r.reviewer_user_id = auth.uid())
  );

create index if not exists idx_review_responses_review on public.review_responses(review_id);

-- ---------------------------------------------------------------------
-- 6. Development plans + items (links competency gaps → training → goals)
-- ---------------------------------------------------------------------
create table if not exists public.development_plans (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  employee_id uuid not null references public.employees(id) on delete cascade,
  cycle_id uuid references public.performance_cycles(id) on delete set null,
  title text not null,
  summary text,
  status text not null default 'draft'
    check (status in ('draft','active','completed','cancelled')),
  start_date date,
  target_completion_date date,
  manager_user_id uuid,
  approved_by uuid,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
grant select, insert, update, delete on public.development_plans to authenticated;
grant all on public.development_plans to service_role;
alter table public.development_plans enable row level security;
create policy "dev_plans visible" on public.development_plans
  for select to authenticated
  using (
    employee_id = public.current_employee_id(organization_id)
    or public.is_manager_of(auth.uid(), employee_id)
  );
create policy "dev_plans write" on public.development_plans
  for all to authenticated
  using (
    employee_id = public.current_employee_id(organization_id)
    or public.is_manager_of(auth.uid(), employee_id)
  )
  with check (
    employee_id = public.current_employee_id(organization_id)
    or public.is_manager_of(auth.uid(), employee_id)
  );

create table if not exists public.development_plan_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  plan_id uuid not null references public.development_plans(id) on delete cascade,
  item_type text not null check (item_type in ('competency','training','goal','reading','mentoring','stretch_assignment','other')),
  title text not null,
  description text,
  competency_id uuid references public.competencies(id) on delete set null,
  training_course_id uuid references public.training_courses(id) on delete set null,
  goal_id uuid references public.performance_goals(id) on delete set null,
  enrollment_id uuid references public.training_enrollments(id) on delete set null,
  due_date date,
  status text not null default 'planned'
    check (status in ('planned','in_progress','completed','skipped')),
  progress_pct numeric(5,2) not null default 0,
  completed_at timestamptz,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
grant select, insert, update, delete on public.development_plan_items to authenticated;
grant all on public.development_plan_items to service_role;
alter table public.development_plan_items enable row level security;
create policy "dev_plan_items visible" on public.development_plan_items
  for select to authenticated
  using (
    exists (select 1 from public.development_plans p
            where p.id = development_plan_items.plan_id
              and (p.employee_id = public.current_employee_id(p.organization_id)
                   or public.is_manager_of(auth.uid(), p.employee_id)))
  );
create policy "dev_plan_items write" on public.development_plan_items
  for all to authenticated
  using (
    exists (select 1 from public.development_plans p
            where p.id = development_plan_items.plan_id
              and (p.employee_id = public.current_employee_id(p.organization_id)
                   or public.is_manager_of(auth.uid(), p.employee_id)))
  )
  with check (
    exists (select 1 from public.development_plans p
            where p.id = development_plan_items.plan_id
              and (p.employee_id = public.current_employee_id(p.organization_id)
                   or public.is_manager_of(auth.uid(), p.employee_id)))
  );

create index if not exists idx_dev_plan_items_plan on public.development_plan_items(plan_id, sort_order);

-- ---------------------------------------------------------------------
-- 7. Extend training_courses + training_enrollments to feed development
-- ---------------------------------------------------------------------
alter table public.training_courses
  add column if not exists competency_ids uuid[] not null default '{}'::uuid[],
  add column if not exists target_level smallint check (target_level between 1 and 5),
  add column if not exists delivery_mode text default 'self_paced'
    check (delivery_mode in ('self_paced','instructor_led','external','on_the_job'));

alter table public.training_enrollments
  add column if not exists source text not null default 'manager_assigned'
    check (source in ('self_requested','manager_assigned','development_plan','auto_suggested','compliance')),
  add column if not exists development_plan_item_id uuid references public.development_plan_items(id) on delete set null,
  add column if not exists due_date date;

-- ---------------------------------------------------------------------
-- 8. updated_at triggers for every new table
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'goal_milestones','competency_scales','competency_role_requirements',
    'competency_assessments','review_templates','review_template_sections',
    'review_template_questions','review_participants','review_responses',
    'development_plans','development_plan_items'
  ]
  loop
    execute format(
      'drop trigger if exists trg_%I_updated_at on public.%I;
       create trigger trg_%I_updated_at before update on public.%I
       for each row execute function public.update_updated_at_column();',
      t, t, t, t
    );
  end loop;
end$$;
