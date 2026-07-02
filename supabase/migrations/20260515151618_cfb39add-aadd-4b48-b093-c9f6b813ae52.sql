-- Payroll-level org settings table (mirrors attendance_settings/timesheet_settings pattern).
-- The first user-visible knob it carries is `pdf_show_explainer`, which controls whether the
-- generate-payslip-pdf function appends per-line bracket-breakdown subnotes ("0–24,000 @ 10% = 2,400")
-- after each deduction/contribution row. Defaults to true so payslips become more transparent.

CREATE TABLE IF NOT EXISTS public.payroll_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  pdf_show_explainer boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id)
);

ALTER TABLE public.payroll_settings ENABLE ROW LEVEL SECURITY;

-- Anyone with payroll-view access in the org can read the row.
CREATE POLICY "payroll_settings_select_same_org"
  ON public.payroll_settings
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.organization_id = payroll_settings.organization_id
    )
  );

-- Only org admins/owners may mutate.
CREATE POLICY "payroll_settings_mutate_admin"
  ON public.payroll_settings
  FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.organization_id = payroll_settings.organization_id
        AND ur.role IN ('owner','admin')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.organization_id = payroll_settings.organization_id
        AND ur.role IN ('owner','admin')
    )
  );

CREATE TRIGGER trg_payroll_settings_updated_at
  BEFORE UPDATE ON public.payroll_settings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();