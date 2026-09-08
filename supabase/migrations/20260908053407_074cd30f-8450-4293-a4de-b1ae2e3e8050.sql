UPDATE public.permission_group_rules r
   SET can_write = true, can_create = true
  FROM public.permission_groups g
 WHERE g.id = r.permission_group_id
   AND g.name = 'Loan Officer'
   AND r.module = 'collections';

DO $$
DECLARE v_src text; v_new text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'seed_default_permission_groups';
  v_new := replace(
    v_src,
    '''Loan Officer'',''collections'',   true,false,false,false,false,false,false,false,false,false',
    '''Loan Officer'',''collections'',   true,true,true,false,false,false,false,false,false,false'
  );
  IF v_new = v_src THEN
    RAISE EXCEPTION 'seed_default_permission_groups: Loan Officer collections row not found';
  END IF;
  EXECUTE format(
    'CREATE OR REPLACE FUNCTION public.seed_default_permission_groups(p_org_id uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS %L',
    v_new
  );
END $$;