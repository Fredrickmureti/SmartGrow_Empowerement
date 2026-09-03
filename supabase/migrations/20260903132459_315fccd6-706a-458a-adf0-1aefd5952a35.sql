CREATE OR REPLACE FUNCTION public.mf_guard_batch_closure()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status text;
BEGIN
  IF TG_TABLE_NAME = 'mf_repayment_batches' THEN
    IF OLD.status = 'closed' AND NEW.status <> 'closed' THEN
      RAISE EXCEPTION 'A closed collection batch cannot be reopened';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.batch_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.batch_id IS DISTINCT FROM OLD.batch_id) THEN
    SELECT status INTO v_status FROM public.mf_repayment_batches WHERE id = NEW.batch_id;
    IF v_status = 'closed' THEN
      RAISE EXCEPTION 'This collection batch is closed; open a new batch to record the payment';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS mf_repayment_batches_closure_guard ON public.mf_repayment_batches;
CREATE TRIGGER mf_repayment_batches_closure_guard
  BEFORE UPDATE ON public.mf_repayment_batches
  FOR EACH ROW EXECUTE FUNCTION public.mf_guard_batch_closure();

DROP TRIGGER IF EXISTS mf_repayments_closed_batch_guard ON public.mf_repayments;
CREATE TRIGGER mf_repayments_closed_batch_guard
  BEFORE INSERT OR UPDATE ON public.mf_repayments
  FOR EACH ROW EXECUTE FUNCTION public.mf_guard_batch_closure();