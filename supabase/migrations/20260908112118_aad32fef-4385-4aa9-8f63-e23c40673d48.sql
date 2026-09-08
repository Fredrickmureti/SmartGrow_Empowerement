ALTER VIEW public.mf_loan_balances SET (security_invoker = on);

DROP FUNCTION IF EXISTS public.mf_loans_repayment_guard_settled(uuid);

CREATE OR REPLACE FUNCTION public.mf_repayments_refuse_settled_loan()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_succ text;
BEGIN
  SELECT s.loan_number INTO v_succ
    FROM public.mf_loans l
    JOIN public.mf_loans s ON s.id = l.settled_by_loan_id
   WHERE l.id = NEW.loan_id;
  IF v_succ IS NOT NULL THEN
    RAISE EXCEPTION 'This loan was replaced by loan %. Record the repayment against that loan instead.', v_succ;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_mf_repayments_refuse_settled_loan ON public.mf_repayments;
CREATE TRIGGER trg_mf_repayments_refuse_settled_loan
BEFORE INSERT ON public.mf_repayments
FOR EACH ROW EXECUTE FUNCTION public.mf_repayments_refuse_settled_loan();
