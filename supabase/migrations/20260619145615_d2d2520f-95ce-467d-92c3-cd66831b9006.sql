
-- P1 step 8 (retry): comp-history capture trigger on contracts only.
-- (employees.basic_salary does not exist in this schema — basic salary lives
-- entirely on employee_contracts.)

CREATE OR REPLACE FUNCTION public.capture_contract_compensation_history()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_currency text;
BEGIN
  IF TG_OP = 'UPDATE'
     AND COALESCE(NEW.wage, 0) = COALESCE(OLD.wage, 0)
     AND COALESCE(NEW.housing_allowance, 0) = COALESCE(OLD.housing_allowance, 0)
     AND COALESCE(NEW.transport_allowance, 0) = COALESCE(OLD.transport_allowance, 0)
     AND COALESCE(NEW.other_allowances::text, '{}') = COALESCE(OLD.other_allowances::text, '{}')
  THEN
    RETURN NEW;
  END IF;

  SELECT b.default_currency_code INTO v_currency
  FROM public.businesses b WHERE b.id = NEW.business_id;

  INSERT INTO public.employee_compensation_history(
    organization_id, business_id, employee_id, effective_date,
    basic_salary, allowances_json, currency_code, change_type,
    reason, source_contract_id, created_by
  ) VALUES (
    NEW.organization_id, NEW.business_id, NEW.employee_id,
    COALESCE(NEW.start_date, CURRENT_DATE),
    COALESCE(NEW.wage, 0),
    jsonb_build_object(
      'housing_allowance', COALESCE(NEW.housing_allowance, 0),
      'transport_allowance', COALESCE(NEW.transport_allowance, 0),
      'other_allowances', COALESCE(NEW.other_allowances, '{}'::jsonb)
    ),
    v_currency,
    CASE WHEN TG_OP = 'INSERT' THEN 'contract_created' ELSE 'contract_updated' END,
    'Auto-captured from employee_contracts ' || TG_OP,
    NEW.id,
    NEW.created_by
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'capture_contract_compensation_history failed: %', SQLERRM;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_capture_contract_comp_history ON public.employee_contracts;
CREATE TRIGGER trg_capture_contract_comp_history
AFTER INSERT OR UPDATE ON public.employee_contracts
FOR EACH ROW EXECUTE FUNCTION public.capture_contract_compensation_history();
