CREATE OR REPLACE FUNCTION public._permission_group_default_scope()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.is_system AND NEW.default_branch_scope IS NULL THEN
    NEW.default_branch_scope := CASE NEW.name
      WHEN 'Institution Admin'  THEN 'all'
      WHEN 'Accountant'         THEN 'all'
      WHEN 'Auditor'            THEN 'all'
      WHEN 'Branch Manager'     THEN 'assigned'
      WHEN 'Credit Analyst'     THEN 'assigned'
      WHEN 'Loan Officer'       THEN 'own_portfolio'
      WHEN 'Cashier / Teller'   THEN 'own_portfolio'
      ELSE NULL
    END::public.branch_scope_mode;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS permission_group_default_scope ON public.permission_groups;
CREATE TRIGGER permission_group_default_scope
  BEFORE INSERT OR UPDATE ON public.permission_groups
  FOR EACH ROW EXECUTE FUNCTION public._permission_group_default_scope();