CREATE OR REPLACE FUNCTION public.trg_reeval_org_readiness_nobusiness()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_org uuid;
BEGIN
  v_org := COALESCE(NEW.organization_id, OLD.organization_id);
  IF v_org IS NULL THEN RETURN NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM organizations WHERE id = v_org) THEN RETURN NULL; END IF;
  PERFORM public.evaluate_payroll_readiness_quiet(v_org, NULL, 'org', NULL, NULL, NULL);
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_reeval_org_readiness()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_org uuid; v_biz uuid;
BEGIN
  v_org := COALESCE(NEW.organization_id, OLD.organization_id);
  BEGIN v_biz := COALESCE(NEW.business_id, OLD.business_id);
  EXCEPTION WHEN undefined_column THEN v_biz := NULL; END;
  IF v_org IS NULL THEN RETURN NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM organizations WHERE id = v_org) THEN RETURN NULL; END IF;
  PERFORM public.evaluate_payroll_readiness_quiet(v_org, NULL, 'org', NULL, NULL, NULL);
  IF v_biz IS NOT NULL AND EXISTS (SELECT 1 FROM businesses WHERE id = v_biz) THEN
    PERFORM public.evaluate_payroll_readiness_quiet(v_org, v_biz, 'org', NULL, NULL, NULL);
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_reeval_employee_readiness()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_emp uuid; v_org uuid; v_biz uuid;
BEGIN
  v_emp := COALESCE(NEW.employee_id, OLD.employee_id);
  IF v_emp IS NULL THEN RETURN NULL; END IF;
  SELECT organization_id, business_id INTO v_org, v_biz FROM employees WHERE id = v_emp;
  IF v_org IS NULL THEN RETURN NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM organizations WHERE id = v_org) THEN RETURN NULL; END IF;
  PERFORM public.evaluate_payroll_readiness_quiet(v_org, v_biz, 'employee', ARRAY[v_emp], NULL, NULL);
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_reeval_employee_self_readiness()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_emp uuid; v_org uuid; v_biz uuid;
BEGIN
  v_emp := COALESCE(NEW.id, OLD.id);
  v_org := COALESCE(NEW.organization_id, OLD.organization_id);
  v_biz := COALESCE(NEW.business_id, OLD.business_id);
  IF v_org IS NULL OR v_emp IS NULL THEN RETURN NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM organizations WHERE id = v_org) THEN RETURN NULL; END IF;
  IF TG_OP = 'DELETE' THEN
    PERFORM public.evaluate_payroll_readiness_quiet(v_org, v_biz, 'org', NULL, NULL, NULL);
  ELSE
    PERFORM public.evaluate_payroll_readiness_quiet(v_org, v_biz, 'employee', ARRAY[v_emp], NULL, NULL);
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_employments_readiness()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_org uuid; v_emp uuid;
BEGIN
  v_org := COALESCE(NEW.organization_id, OLD.organization_id);
  v_emp := COALESCE(NEW.employee_id, OLD.employee_id);
  IF v_org IS NULL THEN RETURN COALESCE(NEW, OLD); END IF;
  IF NOT EXISTS (SELECT 1 FROM organizations WHERE id = v_org) THEN RETURN COALESCE(NEW, OLD); END IF;
  PERFORM public.evaluate_payroll_readiness_quiet(v_org, NULL::uuid, 'employee', v_emp);
  RETURN COALESCE(NEW, OLD);
END;
$$;