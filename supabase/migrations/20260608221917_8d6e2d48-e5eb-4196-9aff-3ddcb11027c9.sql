
-- ============================================================
-- HR Configuration: statutory field config, document categories, policies
-- ============================================================

create table if not exists public.hr_statutory_field_config (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  business_id uuid not null,
  identifier_type text not null,
  country_code text,
  label text,
  help_text text,
  validation_regex text,
  is_required boolean not null default false,
  blocks_onboarding boolean not null default false,
  blocks_payroll boolean not null default false,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, identifier_type, country_code)
);

grant select, insert, update, delete on public.hr_statutory_field_config to authenticated;
grant all on public.hr_statutory_field_config to service_role;
alter table public.hr_statutory_field_config enable row level security;

create policy hr_stat_field_read on public.hr_statutory_field_config
  for select to authenticated
  using (public.user_has_module_permission(auth.uid(), organization_id, 'hr', 'read'));

create policy hr_stat_field_write on public.hr_statutory_field_config
  for all to authenticated
  using (public.user_has_module_permission(auth.uid(), organization_id, 'hr', 'write'))
  with check (public.user_has_module_permission(auth.uid(), organization_id, 'hr', 'write'));

create trigger trg_hr_stat_field_updated
  before update on public.hr_statutory_field_config
  for each row execute function public.update_updated_at_column();

create index hr_stat_field_business_idx
  on public.hr_statutory_field_config (business_id, is_active);


-- ============================================================
create table if not exists public.hr_document_categories (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  business_id uuid not null,
  code text not null,
  name text not null,
  description text,
  is_required_for_onboarding boolean not null default false,
  retention_days integer,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, code)
);

grant select, insert, update, delete on public.hr_document_categories to authenticated;
grant all on public.hr_document_categories to service_role;
alter table public.hr_document_categories enable row level security;

create policy hr_doc_cat_read on public.hr_document_categories
  for select to authenticated
  using (public.user_has_module_permission(auth.uid(), organization_id, 'hr', 'read'));

create policy hr_doc_cat_write on public.hr_document_categories
  for all to authenticated
  using (public.user_has_module_permission(auth.uid(), organization_id, 'hr', 'write'))
  with check (public.user_has_module_permission(auth.uid(), organization_id, 'hr', 'write'));

create trigger trg_hr_doc_cat_updated
  before update on public.hr_document_categories
  for each row execute function public.update_updated_at_column();


-- ============================================================
create table if not exists public.hr_policies (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  business_id uuid not null unique,
  probation_period_months integer not null default 3,
  notice_period_days integer not null default 30,
  leave_year_start_month integer not null default 1
    check (leave_year_start_month between 1 and 12),
  employee_number_format text not null default 'EMP-{seq:0000}',
  employee_number_next_seq integer not null default 1,
  default_onboarding_template_id uuid references public.onboarding_templates(id) on delete set null,
  default_offboarding_template_id uuid references public.onboarding_templates(id) on delete set null,
  retire_age integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

grant select, insert, update, delete on public.hr_policies to authenticated;
grant all on public.hr_policies to service_role;
alter table public.hr_policies enable row level security;

create policy hr_policies_read on public.hr_policies
  for select to authenticated
  using (public.user_has_module_permission(auth.uid(), organization_id, 'hr', 'read'));

create policy hr_policies_write on public.hr_policies
  for all to authenticated
  using (public.user_has_module_permission(auth.uid(), organization_id, 'hr', 'write'))
  with check (public.user_has_module_permission(auth.uid(), organization_id, 'hr', 'write'));

create trigger trg_hr_policies_updated
  before update on public.hr_policies
  for each row execute function public.update_updated_at_column();


-- ============================================================
-- Hire trigger: when an employee is inserted, copy the business's default
-- onboarding template into employee_onboarding + employee_onboarding_items.
-- ============================================================

create or replace function public.hr_apply_default_onboarding()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tpl uuid;
  v_onboarding_id uuid;
begin
  select default_onboarding_template_id into v_tpl
    from public.hr_policies
   where business_id = NEW.business_id;

  if v_tpl is null then
    return NEW;
  end if;

  insert into public.employee_onboarding (
    organization_id, business_id, employee_id, template_id,
    onboarding_type, status, started_at
  ) values (
    NEW.organization_id, NEW.business_id, NEW.id, v_tpl,
    'onboarding', 'in_progress', now()
  )
  returning id into v_onboarding_id;

  insert into public.employee_onboarding_items (
    onboarding_id, title, description, category, sort_order, is_completed
  )
  select v_onboarding_id, title, description, coalesce(category,'general'), sort_order, false
    from public.onboarding_template_items
   where template_id = v_tpl
   order by sort_order;

  return NEW;
exception when others then
  -- never block the hire on a configuration glitch
  raise warning 'hr_apply_default_onboarding skipped for employee %: %', NEW.id, sqlerrm;
  return NEW;
end;
$$;

drop trigger if exists trg_hr_apply_default_onboarding on public.employees;
create trigger trg_hr_apply_default_onboarding
  after insert on public.employees
  for each row execute function public.hr_apply_default_onboarding();
