
CREATE OR REPLACE FUNCTION public.__ts_wave5_seed_ids(_org uuid, _biz uuid, _num text, _first text, _last text, _hire date, _user uuid, _mgr uuid)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $f$
DECLARE v_id uuid;
BEGIN
  INSERT INTO public.profiles(user_id, email)
  SELECT u.id, COALESCE(u.email, u.id::text||'@probe.invalid') FROM auth.users u WHERE u.id = _user
  ON CONFLICT (user_id) DO NOTHING;

  PERFORM set_config('app.identity_change_source','link_employee_to_user', true);
  INSERT INTO public.employees(organization_id,business_id,employee_number,first_name,last_name,hire_date,user_id,manager_id,is_active,lifecycle_status)
  VALUES (_org,_biz,_num,_first,_last,_hire,_user,_mgr,true,'active') RETURNING id INTO v_id;
  PERFORM set_config('app.identity_change_source','', true);
  RETURN v_id;
END;
$f$;
REVOKE ALL ON FUNCTION public.__ts_wave5_seed_ids(uuid,uuid,text,text,text,date,uuid,uuid) FROM PUBLIC, anon, authenticated;
