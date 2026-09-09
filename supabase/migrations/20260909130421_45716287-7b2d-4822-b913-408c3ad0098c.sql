CREATE OR REPLACE FUNCTION public.mf_clients_guard_and_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid;
  v_parts text[] := ARRAY[]::text[];
BEGIN
  IF NEW.business_id IS DISTINCT FROM OLD.business_id THEN
    RAISE EXCEPTION 'A client cannot be moved to another institution.' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.client_number IS DISTINCT FROM OLD.client_number THEN
    RAISE EXCEPTION 'The client number is assigned by the system and cannot be changed.' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.joined_on IS DISTINCT FROM OLD.joined_on THEN
    RAISE EXCEPTION 'The date a client joined cannot be changed.' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.completed_cycles IS DISTINCT FROM OLD.completed_cycles THEN
    RAISE EXCEPTION 'Completed loan cycles are maintained by the lending workflow and cannot be edited.' USING ERRCODE = 'P0001';
  END IF;

  IF NEW.branch_id IS DISTINCT FROM OLD.branch_id THEN
    v_parts := v_parts || format('branch %s -> %s', OLD.branch_id, NEW.branch_id);
  END IF;
  IF NEW.loan_officer_id IS DISTINCT FROM OLD.loan_officer_id THEN
    v_parts := v_parts || format('loan officer %s -> %s', COALESCE(OLD.loan_officer_id::text, 'unassigned'), COALESCE(NEW.loan_officer_id::text, 'unassigned'));
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    v_parts := v_parts || format('status %s -> %s', OLD.status, NEW.status);
  END IF;

  IF array_length(v_parts, 1) IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT b.organization_id INTO v_org FROM public.businesses b WHERE b.id = NEW.business_id;
  IF v_org IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.audit_logs (
    organization_id, business_id, user_id, action, entity_type, entity_id, entity_name,
    old_values, new_values, changes_summary
  ) VALUES (
    v_org, NEW.business_id, auth.uid(), 'update', 'mf_client', NEW.id, NEW.full_name,
    jsonb_build_object('branch_id', OLD.branch_id, 'loan_officer_id', OLD.loan_officer_id, 'status', OLD.status),
    jsonb_build_object('branch_id', NEW.branch_id, 'loan_officer_id', NEW.loan_officer_id, 'status', NEW.status),
    array_to_string(v_parts, '; ')
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS mf_clients_guard_and_audit ON public.mf_clients;
CREATE TRIGGER mf_clients_guard_and_audit
BEFORE UPDATE ON public.mf_clients
FOR EACH ROW EXECUTE FUNCTION public.mf_clients_guard_and_audit();