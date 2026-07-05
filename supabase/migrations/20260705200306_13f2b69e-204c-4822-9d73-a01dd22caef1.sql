
-- Payment status projection
CREATE OR REPLACE FUNCTION public.payroll_recompute_run_payment_status(_run_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_total_payslips integer;
  v_paid_payslips  integer;
  v_current text;
  v_next text;
BEGIN
  IF _run_id IS NULL THEN RETURN; END IF;
  SELECT payment_status INTO v_current FROM public.payroll_runs WHERE id = _run_id;
  IF NOT FOUND THEN RETURN; END IF;
  IF v_current = 'on_hold' THEN RETURN; END IF;

  SELECT COUNT(*) INTO v_total_payslips FROM public.payslips WHERE payroll_run_id = _run_id;
  IF v_total_payslips = 0 THEN
    v_next := 'pending';
  ELSE
    SELECT COUNT(DISTINCT bi.payslip_id) INTO v_paid_payslips
      FROM public.payroll_payment_batch_items bi
      JOIN public.payroll_payment_batches b ON b.id = bi.batch_id
     WHERE b.payroll_run_id = _run_id
       AND bi.item_status = 'paid';
    IF v_paid_payslips = 0 THEN v_next := 'pending';
    ELSIF v_paid_payslips < v_total_payslips THEN v_next := 'partially_paid';
    ELSE v_next := 'fully_paid'; END IF;
  END IF;

  IF v_next IS DISTINCT FROM v_current THEN
    UPDATE public.payroll_runs SET payment_status = v_next, updated_at = now() WHERE id = _run_id;
  END IF;
END $$;
GRANT EXECUTE ON FUNCTION public.payroll_recompute_run_payment_status(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.trg_payment_batch_items_payment_status()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_run uuid; v_old_run uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT payroll_run_id INTO v_run FROM public.payroll_payment_batches WHERE id = OLD.batch_id;
    PERFORM public.payroll_recompute_run_payment_status(v_run);
    RETURN OLD;
  END IF;
  SELECT payroll_run_id INTO v_run FROM public.payroll_payment_batches WHERE id = NEW.batch_id;
  PERFORM public.payroll_recompute_run_payment_status(v_run);
  IF TG_OP = 'UPDATE' AND NEW.batch_id IS DISTINCT FROM OLD.batch_id THEN
    SELECT payroll_run_id INTO v_old_run FROM public.payroll_payment_batches WHERE id = OLD.batch_id;
    PERFORM public.payroll_recompute_run_payment_status(v_old_run);
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_payment_batch_items_payment_status ON public.payroll_payment_batch_items;
CREATE TRIGGER trg_payment_batch_items_payment_status
AFTER INSERT OR UPDATE OF item_status, paid_at, batch_id, payslip_id OR DELETE
ON public.payroll_payment_batch_items
FOR EACH ROW EXECUTE FUNCTION public.trg_payment_batch_items_payment_status();

CREATE OR REPLACE FUNCTION public.trg_payment_batches_payment_status()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.payroll_recompute_run_payment_status(OLD.payroll_run_id);
    RETURN OLD;
  END IF;
  PERFORM public.payroll_recompute_run_payment_status(NEW.payroll_run_id);
  IF TG_OP = 'UPDATE' AND NEW.payroll_run_id IS DISTINCT FROM OLD.payroll_run_id THEN
    PERFORM public.payroll_recompute_run_payment_status(OLD.payroll_run_id);
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_payment_batches_payment_status ON public.payroll_payment_batches;
CREATE TRIGGER trg_payment_batches_payment_status
AFTER INSERT OR UPDATE OF payroll_run_id OR DELETE
ON public.payroll_payment_batches
FOR EACH ROW EXECUTE FUNCTION public.trg_payment_batches_payment_status();

DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT DISTINCT payroll_run_id FROM public.payroll_payment_batches WHERE payroll_run_id IS NOT NULL LOOP
    PERFORM public.payroll_recompute_run_payment_status(r.payroll_run_id);
  END LOOP;
END $$;

-- Bank files workflow
CREATE TABLE IF NOT EXISTS public.payroll_bank_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  payroll_run_id uuid NOT NULL REFERENCES public.payroll_runs(id) ON DELETE CASCADE,
  payment_batch_id uuid REFERENCES public.payroll_payment_batches(id) ON DELETE SET NULL,
  format text NOT NULL,
  file_name text,
  file_path text,
  file_bytes integer,
  status text NOT NULL DEFAULT 'generated'
    CHECK (status IN ('generated','sent','acknowledged','failed','cancelled')),
  generated_by uuid,
  generated_at timestamptz NOT NULL DEFAULT now(),
  sent_by uuid,
  sent_at timestamptz,
  transmission_reference text,
  acknowledged_at timestamptz,
  acknowledgement_reference text,
  failure_reason text,
  cancelled_by uuid,
  cancelled_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.payroll_bank_files TO authenticated;
GRANT ALL ON public.payroll_bank_files TO service_role;

ALTER TABLE public.payroll_bank_files ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view bank files in their business"
ON public.payroll_bank_files FOR SELECT TO authenticated
USING (
  public.has_role(auth.uid(), 'super_admin')
  OR EXISTS (SELECT 1 FROM public.user_business_access uba
              WHERE uba.user_id = auth.uid() AND uba.business_id = payroll_bank_files.business_id)
);

CREATE POLICY "Payroll operators can create bank files"
ON public.payroll_bank_files FOR INSERT TO authenticated
WITH CHECK (
  public.has_role(auth.uid(), 'super_admin')
  OR EXISTS (SELECT 1 FROM public.user_business_access uba
              WHERE uba.user_id = auth.uid() AND uba.business_id = payroll_bank_files.business_id)
);

CREATE POLICY "Payroll operators can update bank files"
ON public.payroll_bank_files FOR UPDATE TO authenticated
USING (
  public.has_role(auth.uid(), 'super_admin')
  OR EXISTS (SELECT 1 FROM public.user_business_access uba
              WHERE uba.user_id = auth.uid() AND uba.business_id = payroll_bank_files.business_id)
);

CREATE POLICY "Admins can delete bank files"
ON public.payroll_bank_files FOR DELETE TO authenticated
USING (
  public.has_role(auth.uid(), 'super_admin')
  OR public.has_role(auth.uid(), 'admin')
);

CREATE INDEX IF NOT EXISTS payroll_bank_files_run_idx
  ON public.payroll_bank_files (payroll_run_id, generated_at DESC);
CREATE INDEX IF NOT EXISTS payroll_bank_files_org_idx
  ON public.payroll_bank_files (organization_id, business_id, status);

CREATE OR REPLACE FUNCTION public.trg_payroll_bank_files_touch()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS trg_payroll_bank_files_touch ON public.payroll_bank_files;
CREATE TRIGGER trg_payroll_bank_files_touch
BEFORE UPDATE ON public.payroll_bank_files
FOR EACH ROW EXECUTE FUNCTION public.trg_payroll_bank_files_touch();

CREATE OR REPLACE FUNCTION public.payroll_recompute_run_bank_file_status(_run_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_next text;
BEGIN
  IF _run_id IS NULL THEN RETURN; END IF;
  SELECT CASE
           WHEN COUNT(*) FILTER (WHERE status = 'acknowledged') > 0 THEN 'acknowledged'
           WHEN COUNT(*) FILTER (WHERE status = 'sent') > 0 THEN 'sent'
           WHEN COUNT(*) FILTER (WHERE status = 'generated') > 0 THEN 'generated'
           ELSE 'not_generated'
         END INTO v_next
    FROM public.payroll_bank_files
   WHERE payroll_run_id = _run_id AND status <> 'cancelled';

  UPDATE public.payroll_runs
     SET bank_file_status = v_next, updated_at = now()
   WHERE id = _run_id AND bank_file_status IS DISTINCT FROM v_next;
END $$;
GRANT EXECUTE ON FUNCTION public.payroll_recompute_run_bank_file_status(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.trg_payroll_bank_files_status_rollup()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.payroll_recompute_run_bank_file_status(OLD.payroll_run_id);
    RETURN OLD;
  END IF;
  PERFORM public.payroll_recompute_run_bank_file_status(NEW.payroll_run_id);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_payroll_bank_files_status_rollup ON public.payroll_bank_files;
CREATE TRIGGER trg_payroll_bank_files_status_rollup
AFTER INSERT OR UPDATE OF status OR DELETE
ON public.payroll_bank_files
FOR EACH ROW EXECUTE FUNCTION public.trg_payroll_bank_files_status_rollup();
