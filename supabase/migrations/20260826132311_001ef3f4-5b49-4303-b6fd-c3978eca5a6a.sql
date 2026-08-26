
CREATE OR REPLACE FUNCTION public.__ts_wave5_probe()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  org uuid := gen_random_uuid();
  biz uuid := gen_random_uuid();
  u_sub  uuid := 'af903a2e-3ab0-43f5-b2f0-1a4000985084';
  u_mgr  uuid := '81c0b017-ee1b-4d25-a498-f1c6ed3f0e52';
  u_pm   uuid := '351895bd-78d1-49e9-8757-5ca681562940';
  u_oth  uuid := '5c15d080-11fd-4f25-b943-539a71306233';
  e_sub uuid; e_mgr uuid; e_pm uuid; e_oth uuid;
  proj uuid := gen_random_uuid();
  sub1 uuid; sub2 uuid;
  d0 date := date '2031-03-03';
  d1 date := date '2031-03-07';
  r jsonb := '{}'::jsonb;
BEGIN
  INSERT INTO public.organizations(id,name,slug,governance_mode)
  VALUES (org,'WAVE5 PROBE','wave5-'||substr(org::text,1,8),'standard');
  INSERT INTO public.businesses(id,organization_id,name,country)
  VALUES (biz,org,'WAVE5 PROBE BIZ','KE');
  INSERT INTO public.organization_installed_apps(organization_id,app_id)
  VALUES (org,'employees'),(org,'timesheets'),(org,'projects'),(org,'hr');

  e_mgr := public.__ts_wave5_seed_ids(org,biz,'W5-MGR','Mia','Manager',d0,u_mgr,NULL);
  e_pm  := public.__ts_wave5_seed_ids(org,biz,'W5-PM','Pat','ProjectManager',d0,u_pm,NULL);
  e_oth := public.__ts_wave5_seed_ids(org,biz,'W5-OTH','Otto','Other',d0,u_oth,NULL);
  e_sub := public.__ts_wave5_seed_ids(org,biz,'W5-EMP','Sam','Subject',d0,u_sub,e_mgr);

  INSERT INTO public.projects(id,organization_id,business_id,project_number,name,manager_id,is_billable,allow_timesheets,status)
  VALUES (proj,org,biz,'W5-P1','Probe project',e_pm,false,true,'active');

  INSERT INTO public.timesheets(organization_id,business_id,employee_id,project_id,date,hours,status,is_billable,submitted_at)
  VALUES (org,biz,e_sub,proj,d0,8,'submitted',false,now()),
         (org,biz,e_sub,proj,d0+1,6,'submitted',false,now());

  INSERT INTO public.timesheet_submissions(organization_id,business_id,employee_id,period_start,period_end,total_hours,status,submitted_at)
  VALUES (org,biz,e_sub,d0,d1,14,'submitted',now()) RETURNING id INTO sub1;

  r := r || jsonb_build_object(
    'competence_direct_manager', public._timesheet_can_approve(u_mgr, sub1),
    'competence_project_manager', public._timesheet_can_approve(u_pm, sub1),
    'competence_unrelated_user', public._timesheet_can_approve(u_oth, sub1),
    'competence_self', public._timesheet_can_approve(u_sub, sub1));

  PERFORM set_config('request.jwt.claims', json_build_object('sub',u_sub)::text, true);
  UPDATE public.employees SET manager_id = e_sub WHERE id = e_sub;
  BEGIN
    PERFORM public.approve_timesheet_submission(sub1);
    r := r || jsonb_build_object('self_approve_standard','ALLOWED (unexpected)');
  EXCEPTION WHEN OTHERS THEN
    r := r || jsonb_build_object('self_approve_standard','blocked: '||SQLERRM);
  END;

  UPDATE public.organizations SET governance_mode='solo' WHERE id=org;
  UPDATE public.user_roles SET role='admin', user_type='internal' WHERE user_id=u_sub AND organization_id=org;
  BEGIN
    PERFORM public.approve_timesheet_submission(sub1);
    r := r || jsonb_build_object('self_approve_solo','allowed');
  EXCEPTION WHEN OTHERS THEN
    r := r || jsonb_build_object('self_approve_solo','BLOCKED (unexpected): '||SQLERRM);
  END;

  BEGIN
    PERFORM public.approve_timesheet_submission(sub1);
    r := r || jsonb_build_object('duplicate_approve','ALLOWED (unexpected)');
  EXCEPTION WHEN OTHERS THEN
    r := r || jsonb_build_object('duplicate_approve','refused: '||SQLERRM);
  END;

  r := r || jsonb_build_object(
    'events', (SELECT jsonb_agg(event_type||' x'||cnt) FROM (
        SELECT event_type, count(*) cnt FROM public.business_event_outbox
         WHERE org_id=org GROUP BY event_type) x),
    'project_spent_hours', (SELECT spent_hours FROM public.projects WHERE id=proj),
    'cost_entries', (SELECT count(*) FROM public.project_cost_entries WHERE project_id=proj),
    'entries_approved', (SELECT count(*) FROM public.timesheets WHERE organization_id=org AND status='approved'));

  UPDATE public.organizations SET governance_mode='standard' WHERE id=org;
  UPDATE public.user_roles SET role='portal', user_type='portal' WHERE user_id=u_sub AND organization_id=org;

  INSERT INTO public.timesheets(organization_id,business_id,employee_id,project_id,date,hours,status,is_billable,submitted_at)
  VALUES (org,biz,e_sub,proj,d0+7,5,'submitted',false,now());
  INSERT INTO public.timesheet_submissions(organization_id,business_id,employee_id,period_start,period_end,total_hours,status,submitted_at)
  VALUES (org,biz,e_sub,d0+7,d1+7,5,'submitted',now()) RETURNING id INTO sub2;

  r := r || jsonb_build_object('verdict_before_override',
    public.governance_self_action_verdict(u_sub,u_sub,'timesheet.approve',org,sub2));

  INSERT INTO public.self_action_overrides(organization_id,actor_user_id,subject_user_id,action_key,entity_type,entity_id,reason,co_signed_by,expires_at)
  VALUES (org,u_sub,u_sub,'timesheet.approve','timesheet_submission',sub2,'probe',u_mgr,now()+interval '1 hour');

  r := r || jsonb_build_object('verdict_with_override',
    public.governance_self_action_verdict(u_sub,u_sub,'timesheet.approve',org,sub2));

  BEGIN
    PERFORM public.approve_timesheet_submission(sub2);
    r := r || jsonb_build_object('approve_with_override','allowed');
  EXCEPTION WHEN OTHERS THEN
    r := r || jsonb_build_object('approve_with_override','BLOCKED (unexpected): '||SQLERRM);
  END;

  r := r || jsonb_build_object('verdict_after_override_consumed',
    public.governance_self_action_verdict(u_sub,u_sub,'timesheet.approve',org,sub2));

  UPDATE public.timesheets SET payroll_locked=true, payroll_locked_at=now()
   WHERE organization_id=org AND date=d0;
  BEGIN
    UPDATE public.timesheets SET hours=99 WHERE organization_id=org AND date=d0;
    r := r || jsonb_build_object('locked_mutation','ALLOWED (unexpected)');
  EXCEPTION WHEN OTHERS THEN
    r := r || jsonb_build_object('locked_mutation','refused: '||SQLERRM);
  END;

  PERFORM set_config('request.jwt.claims','', true);
  PERFORM set_config('app.reset_in_progress', org::text, true);
  UPDATE public.timesheets SET payroll_locked=false, payroll_locked_at=NULL WHERE organization_id=org;
  DELETE FROM public.self_action_overrides WHERE organization_id=org;
  DELETE FROM public.business_event_outbox WHERE org_id=org;
  DELETE FROM public.notifications WHERE organization_id=org;
  DELETE FROM public.audit_logs WHERE organization_id=org;
  DELETE FROM public.project_cost_entries WHERE project_id=proj;
  DELETE FROM public.timesheets WHERE organization_id=org;
  DELETE FROM public.timesheet_submissions WHERE organization_id=org;
  DELETE FROM public.projects WHERE id=proj;
  PERFORM set_config('app.identity_change_source','unlink_employee_from_user', true);
  UPDATE public.employees SET manager_id=NULL, user_id=NULL WHERE organization_id=org;
  PERFORM set_config('app.identity_change_source','', true);
  DELETE FROM public.employees WHERE organization_id=org;
  DELETE FROM public.user_roles WHERE organization_id=org;
  DELETE FROM public.organization_installed_apps WHERE organization_id=org;
  DELETE FROM public.businesses WHERE organization_id=org;
  DELETE FROM public.organizations WHERE id=org;

  RETURN r;
END;
$fn$;
REVOKE ALL ON FUNCTION public.__ts_wave5_probe() FROM PUBLIC, anon, authenticated;
