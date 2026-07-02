-- Phase 4 P1.3: payslip input lineage.
-- Country-agnostic. Generic provenance kinds only; nothing pack-specific.

ALTER TYPE public.payslip_input_source ADD VALUE IF NOT EXISTS 'override';
ALTER TYPE public.payslip_input_source ADD VALUE IF NOT EXISTS 'variable_input';
ALTER TYPE public.payslip_input_source ADD VALUE IF NOT EXISTS 'loan';
ALTER TYPE public.payslip_input_source ADD VALUE IF NOT EXISTS 'garnishment';
ALTER TYPE public.payslip_input_source ADD VALUE IF NOT EXISTS 'reimbursement';
ALTER TYPE public.payslip_input_source ADD VALUE IF NOT EXISTS 'termination_payout';
ALTER TYPE public.payslip_input_source ADD VALUE IF NOT EXISTS 'statutory_rule';
ALTER TYPE public.payslip_input_source ADD VALUE IF NOT EXISTS 'salary_structure';
ALTER TYPE public.payslip_input_source ADD VALUE IF NOT EXISTS 'retro';
ALTER TYPE public.payslip_input_source ADD VALUE IF NOT EXISTS 'expense';
ALTER TYPE public.payslip_input_source ADD VALUE IF NOT EXISTS 'benefit';

ALTER TABLE public.payslip_inputs
  ADD COLUMN IF NOT EXISTS code text,
  ADD COLUMN IF NOT EXISTS payslip_line_id uuid REFERENCES public.payslip_lines(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_payslip_inputs_payslip_line_id
  ON public.payslip_inputs (payslip_line_id)
  WHERE payslip_line_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payslip_inputs_payslip_code
  ON public.payslip_inputs (payslip_id, code)
  WHERE code IS NOT NULL;

COMMENT ON COLUMN public.payslip_lines.source IS
  'Pack/engine-authored explanation jsonb. May include `bracket_breakdown`, `employee`/`employer` arrays, `rate`/`base`, `explanation`, and (Phase 4 P1.3) `input_ref`: discriminated provenance pointer of shape { kind, ...kind-specific fields } where kind is one of contract | salary_structure | payslip_input | work_entry | leave_request | loan | garnishment | statutory_rule | retro | expense | benefit | termination_payout | override. Country-agnostic — the engine never branches on jurisdiction here.';

COMMENT ON COLUMN public.payslip_inputs.code IS
  'Stable input code matching payroll_input_types.code, and matching the emitted payslip_lines.rule_code when the input maps 1:1 to a line. NULL for legacy aggregate rows (e.g. attendance hours, leave totals).';

COMMENT ON COLUMN public.payslip_inputs.payslip_line_id IS
  'Back-reference to the payslip_lines row this input produced. NULL when the input informs multiple lines or did not produce a line on this run.';