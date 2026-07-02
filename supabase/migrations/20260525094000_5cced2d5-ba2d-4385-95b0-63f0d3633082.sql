
create table if not exists public.report_views (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  business_id     uuid,
  branch_id       uuid,
  user_id         uuid not null,
  report_id       text not null,
  report_type     text,
  path            text,
  params          jsonb not null default '{}'::jsonb,
  opened_at       timestamptz not null default now()
);

create index if not exists idx_report_views_org_time on public.report_views (organization_id, opened_at desc);
create index if not exists idx_report_views_user_time on public.report_views (user_id, opened_at desc);
create index if not exists idx_report_views_report on public.report_views (report_id, opened_at desc);

alter table public.report_views enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='report_views' and policyname='report_views_select_org_members') then
    create policy report_views_select_org_members on public.report_views for select
      using (organization_id in (select ur.organization_id from public.user_roles ur where ur.user_id = auth.uid() and ur.is_active = true));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='report_views' and policyname='report_views_insert_self') then
    create policy report_views_insert_self on public.report_views for insert with check (user_id = auth.uid());
  end if;
end $$;

create or replace function public.log_report_view(
  p_report_id text, p_report_type text default null, p_path text default null,
  p_organization_id uuid default null, p_business_id uuid default null,
  p_branch_id uuid default null, p_params jsonb default '{}'::jsonb
) returns uuid language plpgsql security invoker set search_path = public as $$
declare v_user uuid := auth.uid(); v_org uuid := p_organization_id; v_id uuid;
begin
  if v_user is null then return null; end if;
  if v_org is null then
    select ur.organization_id into v_org from public.user_roles ur
      where ur.user_id = v_user and ur.is_active = true order by ur.created_at asc limit 1;
  end if;
  if v_org is null then return null; end if;
  insert into public.report_views(organization_id, business_id, branch_id, user_id, report_id, report_type, path, params)
    values (v_org, p_business_id, p_branch_id, v_user, p_report_id, p_report_type, p_path, coalesce(p_params, '{}'::jsonb))
    returning id into v_id;
  return v_id;
end; $$;

grant execute on function public.log_report_view(text, text, text, uuid, uuid, uuid, jsonb) to authenticated;

create or replace view public.v_unified_audit as
  select 'audit_logs'::text as source_table, al.id, al.organization_id, al.business_id, al.user_id as actor_id,
    al.action, al.entity_type, al.entity_id::text as entity_id,
    coalesce(al.changes_summary, al.entity_name) as summary,
    jsonb_build_object('old', al.old_values, 'new', al.new_values, 'ip', al.ip_address, 'ua', al.user_agent) as payload,
    al.created_at as occurred_at
  from public.audit_logs al
  union all
  select 'account_change_audit_log', a.id, a.organization_id, a.business_id, a.changed_by,
    a.change_type, 'account'::text, a.account_id::text, a.reason,
    jsonb_build_object('old', a.old_value, 'new', a.new_value), a.changed_at
  from public.account_change_audit_log a
  union all
  select 'settings_audit_log', s.id, s.organization_id, s.business_id, s.actor_id,
    coalesce(s.setting_scope, 'setting_change'), coalesce(s.table_name, s.setting_scope),
    coalesce(s.record_id::text, s.setting_key), s.reason,
    jsonb_build_object('key', s.setting_key, 'old', s.old_value, 'new', s.new_value), s.created_at
  from public.settings_audit_log s
  union all
  select 'commercial_audit_logs', c.id, c.org_id, null::uuid, c.actor_id,
    c.event_type, 'app'::text, coalesce(c.plan_id::text, c.app_id), null::text,
    c.payload, c.created_at
  from public.commercial_audit_logs c
  union all
  select 'default_account_mapping_audit', d.id, d.organization_id, d.business_id, d.performed_by,
    d.action, 'default_account_mapping'::text, d.role_key, d.reason,
    jsonb_build_object('previous_account_id', d.previous_account_id, 'new_account_id', d.new_account_id,
      'confidence', d.confidence, 'score', d.score, 'batch_id', d.batch_id), d.created_at
  from public.default_account_mapping_audit d
  union all
  select 'timesheet_audit_log', t.id, t.organization_id, t.business_id, t.actor_user_id,
    t.action, 'timesheet'::text, t.timesheet_id::text, t.reason,
    jsonb_build_object('from', t.from_status, 'to', t.to_status, 'meta', t.metadata), t.created_at
  from public.timesheet_audit_log t
  union all
  select 'signature_audit_log', sg.id, null::uuid, null::uuid, sg.signer_id,
    sg.action, 'signature_request'::text, sg.request_id::text, null::text,
    jsonb_build_object('ip', sg.ip_address, 'geo', sg.geolocation, 'ua', sg.user_agent, 'details', sg.details),
    sg.created_at
  from public.signature_audit_log sg
  union all
  select 'pack_audit_log', p.id, p.organization_id, null::uuid, p.actor_id,
    p.action, p.entity_table, p.entity_id::text, p.scope,
    jsonb_build_object('before', p.before, 'after', p.after, 'meta', p.metadata), p.created_at
  from public.pack_audit_log p;

comment on view public.v_unified_audit is
  'Phase A: union of all audit log tables, used by the Audit Trail report. RLS is enforced by the underlying tables.';

grant select on public.v_unified_audit to authenticated;
