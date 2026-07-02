-- Trigger: cashier and register must belong to the same business
CREATE OR REPLACE FUNCTION public.enforce_cashier_register_business_match()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cashier_business uuid;
  v_register_business uuid;
BEGIN
  SELECT business_id INTO v_cashier_business FROM public.pos_cashiers WHERE id = NEW.cashier_id;
  SELECT business_id INTO v_register_business FROM public.pos_registers WHERE id = NEW.register_id;

  IF v_cashier_business IS NULL OR v_register_business IS NULL THEN
    RAISE EXCEPTION 'Cashier or register has no business_id (cashier=%, register=%)',
      NEW.cashier_id, NEW.register_id;
  END IF;

  IF v_cashier_business <> v_register_business THEN
    RAISE EXCEPTION 'Cashier business (%) does not match register business (%)',
      v_cashier_business, v_register_business;
  END IF;

  IF NEW.business_id IS DISTINCT FROM v_cashier_business THEN
    RAISE EXCEPTION 'pos_cashier_registers.business_id (%) must equal cashier/register business (%)',
      NEW.business_id, v_cashier_business;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_cashier_register_business_match ON public.pos_cashier_registers;
CREATE TRIGGER trg_enforce_cashier_register_business_match
BEFORE INSERT OR UPDATE ON public.pos_cashier_registers
FOR EACH ROW EXECUTE FUNCTION public.enforce_cashier_register_business_match();

-- Unique branch-level payment method override
CREATE UNIQUE INDEX IF NOT EXISTS uniq_pos_payment_methods_business_branch_method
  ON public.pos_payment_methods (business_id, branch_id, method_key)
  WHERE branch_id IS NOT NULL;