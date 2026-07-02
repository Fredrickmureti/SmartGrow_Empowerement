
-- F2: Extend statutory return run lifecycle with acknowledgement tracking
ALTER TABLE public.payroll_return_runs
  ADD COLUMN IF NOT EXISTS acknowledged_at timestamptz,
  ADD COLUMN IF NOT EXISTS authority_ack_payload jsonb;

ALTER TABLE public.payroll_return_runs
  DROP CONSTRAINT IF EXISTS payroll_return_runs_status_check;

ALTER TABLE public.payroll_return_runs
  ADD CONSTRAINT payroll_return_runs_status_check
  CHECK (status = ANY (ARRAY[
    'draft','generated','submitted_awaiting_ack','acknowledged','rejected','filed','superseded'
  ]));

-- F5: Batch grouping for tax certificate runs
ALTER TABLE public.payroll_tax_certificates
  ADD COLUMN IF NOT EXISTS batch_id uuid;

CREATE INDEX IF NOT EXISTS payroll_tax_certificates_batch_id_idx
  ON public.payroll_tax_certificates(batch_id);

-- F1: Government submission format descriptor on return templates
ALTER TABLE public.localization_pack_return_templates
  ADD COLUMN IF NOT EXISTS submission_format jsonb;

ALTER TABLE public.localization_pack_return_templates
  DROP CONSTRAINT IF EXISTS localization_pack_return_templates_output_check;

ALTER TABLE public.localization_pack_return_templates
  ADD CONSTRAINT localization_pack_return_templates_output_check
  CHECK (output = ANY (ARRAY[
    'csv','pdf','both','gov_csv','gov_xlsx','gov_xml'
  ]));

-- F4: Token inheritance flag for packs (lets pack ship without registry rows by explicit opt-in)
ALTER TABLE public.localization_packs
  ADD COLUMN IF NOT EXISTS tokens_inherit_platform boolean NOT NULL DEFAULT false;
