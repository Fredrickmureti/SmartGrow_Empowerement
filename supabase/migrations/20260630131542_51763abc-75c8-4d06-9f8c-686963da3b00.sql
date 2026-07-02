
DO $$ BEGIN
  CREATE TYPE public.payroll_bank_export_file_status AS ENUM (
    'generated', 'transmitted', 'acknowledged', 'rejected', 'cancelled'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.payroll_bank_export_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  business_id UUID NOT NULL,
  batch_id UUID NOT NULL REFERENCES public.payroll_payment_batches(id) ON DELETE RESTRICT,
  template_id UUID REFERENCES public.localization_pack_bank_export_templates(id) ON DELETE SET NULL,
  format_code TEXT NOT NULL,
  file_name TEXT NOT NULL,
  storage_bucket TEXT,
  storage_path TEXT,
  checksum_sha256 TEXT,
  line_count INT NOT NULL DEFAULT 0,
  total_amount NUMERIC(18,4) NOT NULL DEFAULT 0,
  currency_code TEXT,
  status public.payroll_bank_export_file_status NOT NULL DEFAULT 'generated',
  generated_by UUID,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  transmitted_by UUID,
  transmitted_at TIMESTAMPTZ,
  transmission_reference TEXT,
  acknowledged_at TIMESTAMPTZ,
  acknowledgement_reference TEXT,
  acknowledgement_payload JSONB,
  rejected_at TIMESTAMPTZ,
  rejection_reason TEXT,
  rejection_payload JSONB,
  cancelled_by UUID,
  cancelled_at TIMESTAMPTZ,
  cancel_reason TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.payroll_bank_export_files TO authenticated;
GRANT ALL ON public.payroll_bank_export_files TO service_role;

ALTER TABLE public.payroll_bank_export_files ENABLE ROW LEVEL SECURITY;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_payroll_bank_export_files_active_per_batch
  ON public.payroll_bank_export_files(batch_id)
  WHERE status NOT IN ('cancelled', 'rejected');
CREATE INDEX IF NOT EXISTS idx_payroll_bank_export_files_org_status
  ON public.payroll_bank_export_files(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_payroll_bank_export_files_batch
  ON public.payroll_bank_export_files(batch_id);

DO $pol$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='payroll_bank_export_files' AND policyname='auth read bank export files') THEN
    EXECUTE 'CREATE POLICY "auth read bank export files" ON public.payroll_bank_export_files FOR SELECT TO authenticated USING (true)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='payroll_bank_export_files' AND policyname='auth write bank export files') THEN
    EXECUTE 'CREATE POLICY "auth write bank export files" ON public.payroll_bank_export_files FOR ALL TO authenticated USING (true) WITH CHECK (true)';
  END IF;
END $pol$;

CREATE OR REPLACE FUNCTION public._touch_payroll_bank_export_files_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS trg_touch_payroll_bank_export_files_updated_at ON public.payroll_bank_export_files;
CREATE TRIGGER trg_touch_payroll_bank_export_files_updated_at
  BEFORE UPDATE ON public.payroll_bank_export_files
  FOR EACH ROW EXECUTE FUNCTION public._touch_payroll_bank_export_files_updated_at();

CREATE OR REPLACE FUNCTION public.validate_payroll_bank_export_file_lifecycle()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_from public.payroll_bank_export_file_status;
  v_to   public.payroll_bank_export_file_status;
  v_ok   BOOLEAN;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'generated' THEN
      RAISE EXCEPTION 'Bank export file must start as generated (got %)', NEW.status USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  v_from := OLD.status; v_to := NEW.status;
  IF v_from = v_to THEN RETURN NEW; END IF;
  IF v_from IN ('acknowledged','rejected','cancelled') THEN
    RAISE EXCEPTION 'Bank export file is terminal (%); cannot change status', v_from USING ERRCODE = 'check_violation';
  END IF;
  v_ok := (v_from, v_to) IN (
    ('generated','transmitted'),('generated','cancelled'),
    ('transmitted','acknowledged'),('transmitted','rejected'),('transmitted','cancelled')
  );
  IF NOT v_ok THEN
    RAISE EXCEPTION 'Bank export file: illegal transition % -> %', v_from, v_to USING ERRCODE = 'check_violation';
  END IF;
  IF v_to = 'transmitted' AND NEW.transmitted_at IS NULL THEN NEW.transmitted_at := now(); END IF;
  IF v_to = 'acknowledged' AND NEW.acknowledged_at IS NULL THEN NEW.acknowledged_at := now(); END IF;
  IF v_to = 'rejected' THEN
    IF NEW.rejected_at IS NULL THEN NEW.rejected_at := now(); END IF;
    IF NEW.rejection_reason IS NULL OR length(btrim(NEW.rejection_reason)) = 0 THEN
      RAISE EXCEPTION 'rejection_reason required when rejecting bank export file' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF v_to = 'cancelled' THEN
    IF NEW.cancelled_at IS NULL THEN NEW.cancelled_at := now(); END IF;
    IF NEW.cancel_reason IS NULL OR length(btrim(NEW.cancel_reason)) = 0 THEN
      RAISE EXCEPTION 'cancel_reason required when cancelling bank export file' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_validate_payroll_bank_export_file_lifecycle ON public.payroll_bank_export_files;
CREATE TRIGGER trg_validate_payroll_bank_export_file_lifecycle
  BEFORE INSERT OR UPDATE OF status, transmitted_at, acknowledged_at, rejected_at, cancelled_at, rejection_reason, cancel_reason
  ON public.payroll_bank_export_files
  FOR EACH ROW EXECUTE FUNCTION public.validate_payroll_bank_export_file_lifecycle();

CREATE OR REPLACE FUNCTION public.payroll_bank_export_file_record_transmission(
  _file_id UUID, _transmission_reference TEXT DEFAULT NULL
) RETURNS public.payroll_bank_export_files
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.payroll_bank_export_files;
BEGIN
  UPDATE public.payroll_bank_export_files
    SET status='transmitted', transmitted_by=auth.uid(), transmitted_at=now(),
        transmission_reference=COALESCE(_transmission_reference, transmission_reference)
  WHERE id=_file_id RETURNING * INTO r;
  IF r.id IS NULL THEN RAISE EXCEPTION 'Bank export file not found %', _file_id; END IF;
  UPDATE public.payroll_payment_batches
    SET status='transmitted', transmitted_at=now(), transmitted_by=auth.uid(),
        transmission_reference=COALESCE(_transmission_reference, transmission_reference)
    WHERE id=r.batch_id AND status IN ('exported','approved','locked');
  RETURN r;
END $$;

CREATE OR REPLACE FUNCTION public.payroll_bank_export_file_record_acknowledgement(
  _file_id UUID, _ack_reference TEXT, _payload JSONB DEFAULT NULL
) RETURNS public.payroll_bank_export_files
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.payroll_bank_export_files;
BEGIN
  UPDATE public.payroll_bank_export_files
    SET status='acknowledged', acknowledged_at=now(),
        acknowledgement_reference=_ack_reference,
        acknowledgement_payload=COALESCE(_payload, acknowledgement_payload)
  WHERE id=_file_id RETURNING * INTO r;
  IF r.id IS NULL THEN RAISE EXCEPTION 'Bank export file not found %', _file_id; END IF;
  RETURN r;
END $$;

CREATE OR REPLACE FUNCTION public.payroll_bank_export_file_record_rejection(
  _file_id UUID, _reason TEXT, _payload JSONB DEFAULT NULL
) RETURNS public.payroll_bank_export_files
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.payroll_bank_export_files;
BEGIN
  UPDATE public.payroll_bank_export_files
    SET status='rejected', rejected_at=now(),
        rejection_reason=_reason, rejection_payload=COALESCE(_payload, rejection_payload)
  WHERE id=_file_id RETURNING * INTO r;
  IF r.id IS NULL THEN RAISE EXCEPTION 'Bank export file not found %', _file_id; END IF;
  RETURN r;
END $$;

CREATE OR REPLACE FUNCTION public.payroll_bank_export_file_cancel(
  _file_id UUID, _reason TEXT
) RETURNS public.payroll_bank_export_files
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.payroll_bank_export_files;
BEGIN
  UPDATE public.payroll_bank_export_files
    SET status='cancelled', cancelled_at=now(), cancelled_by=auth.uid(), cancel_reason=_reason
  WHERE id=_file_id RETURNING * INTO r;
  IF r.id IS NULL THEN RAISE EXCEPTION 'Bank export file not found %', _file_id; END IF;
  RETURN r;
END $$;

GRANT EXECUTE ON FUNCTION public.payroll_bank_export_file_record_transmission(uuid, text)        TO authenticated;
GRANT EXECUTE ON FUNCTION public.payroll_bank_export_file_record_acknowledgement(uuid, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.payroll_bank_export_file_record_rejection(uuid, text, jsonb)    TO authenticated;
GRANT EXECUTE ON FUNCTION public.payroll_bank_export_file_cancel(uuid, text)                     TO authenticated;
