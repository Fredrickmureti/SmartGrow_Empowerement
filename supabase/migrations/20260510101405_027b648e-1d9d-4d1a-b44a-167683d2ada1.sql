
-- Stage C: tenant overrides for payroll certificate & return templates
-- Both tables are business-scoped, versioned per (business, template_code),
-- staleness-tracked via base template updated_at, and audit-logged.

create table if not exists public.payroll_certificate_template_overrides (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  business_id uuid not null,
  template_code text not null,
  body jsonb not null,
  layout text,
  notes text,
  base_pack_id uuid,
  base_template_updated_at timestamptz,
  override_version integer not null default 1,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, template_code)
);

create table if not exists public.payroll_return_template_overrides (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  business_id uuid not null,
  template_code text not null,
  body jsonb not null,
  notes text,
  base_pack_id uuid,
  base_template_updated_at timestamptz,
  override_version integer not null default 1,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, template_code)
);

alter table public.payroll_certificate_template_overrides enable row level security;
alter table public.payroll_return_template_overrides enable row level security;

-- RLS: only payroll-write users in the matching org/business may read or mutate.
create policy "cert_overrides_select"
  on public.payroll_certificate_template_overrides for select
  using (public.user_has_module_permission(auth.uid(), organization_id, business_id, 'payroll', 'write'));

create policy "cert_overrides_insert"
  on public.payroll_certificate_template_overrides for insert
  with check (public.user_has_module_permission(auth.uid(), organization_id, business_id, 'payroll', 'write'));

create policy "cert_overrides_update"
  on public.payroll_certificate_template_overrides for update
  using (public.user_has_module_permission(auth.uid(), organization_id, business_id, 'payroll', 'write'))
  with check (public.user_has_module_permission(auth.uid(), organization_id, business_id, 'payroll', 'write'));

create policy "cert_overrides_delete"
  on public.payroll_certificate_template_overrides for delete
  using (public.user_has_module_permission(auth.uid(), organization_id, business_id, 'payroll', 'write'));

create policy "return_overrides_select"
  on public.payroll_return_template_overrides for select
  using (public.user_has_module_permission(auth.uid(), organization_id, business_id, 'payroll', 'write'));

create policy "return_overrides_insert"
  on public.payroll_return_template_overrides for insert
  with check (public.user_has_module_permission(auth.uid(), organization_id, business_id, 'payroll', 'write'));

create policy "return_overrides_update"
  on public.payroll_return_template_overrides for update
  using (public.user_has_module_permission(auth.uid(), organization_id, business_id, 'payroll', 'write'))
  with check (public.user_has_module_permission(auth.uid(), organization_id, business_id, 'payroll', 'write'));

create policy "return_overrides_delete"
  on public.payroll_return_template_overrides for delete
  using (public.user_has_module_permission(auth.uid(), organization_id, business_id, 'payroll', 'write'));

-- updated_at trigger
create or replace function public.touch_payroll_template_override()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  if tg_op = 'UPDATE' then
    new.override_version := coalesce(old.override_version, 0) + 1;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_touch_cert_override on public.payroll_certificate_template_overrides;
create trigger trg_touch_cert_override before update on public.payroll_certificate_template_overrides
  for each row execute function public.touch_payroll_template_override();

drop trigger if exists trg_touch_return_override on public.payroll_return_template_overrides;
create trigger trg_touch_return_override before update on public.payroll_return_template_overrides
  for each row execute function public.touch_payroll_template_override();

-- Audit-log trigger writes to public.audit_logs
create or replace function public.audit_payroll_template_override()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_action text;
  v_old jsonb;
  v_new jsonb;
  v_org uuid;
  v_biz uuid;
  v_code text;
  v_actor uuid;
  v_summary text;
begin
  if tg_op = 'INSERT' then
    v_action := 'create'; v_old := null; v_new := to_jsonb(new);
    v_org := new.organization_id; v_biz := new.business_id; v_code := new.template_code;
    v_actor := new.created_by;
    v_summary := 'Override created (reason: ' || coalesce(new.notes, '') || ')';
  elsif tg_op = 'UPDATE' then
    v_action := 'update'; v_old := to_jsonb(old); v_new := to_jsonb(new);
    v_org := new.organization_id; v_biz := new.business_id; v_code := new.template_code;
    v_actor := coalesce(new.updated_by, new.created_by);
    v_summary := 'Override updated to v' || new.override_version || ' (reason: ' || coalesce(new.notes, '') || ')';
  else
    v_action := 'delete'; v_old := to_jsonb(old); v_new := null;
    v_org := old.organization_id; v_biz := old.business_id; v_code := old.template_code;
    v_actor := old.updated_by;
    v_summary := 'Override reset to pack default';
  end if;
  insert into public.audit_logs(organization_id, business_id, user_id, action, entity_type, entity_id, entity_name, old_values, new_values, changes_summary)
  values (v_org, v_biz, v_actor, v_action, tg_table_name, coalesce((v_new->>'id')::uuid, (v_old->>'id')::uuid), v_code, v_old, v_new, v_summary);
  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_audit_cert_override on public.payroll_certificate_template_overrides;
create trigger trg_audit_cert_override after insert or update or delete on public.payroll_certificate_template_overrides
  for each row execute function public.audit_payroll_template_override();

drop trigger if exists trg_audit_return_override on public.payroll_return_template_overrides;
create trigger trg_audit_return_override after insert or update or delete on public.payroll_return_template_overrides
  for each row execute function public.audit_payroll_template_override();

create index if not exists idx_cert_overrides_business on public.payroll_certificate_template_overrides(business_id, template_code);
create index if not exists idx_return_overrides_business on public.payroll_return_template_overrides(business_id, template_code);
