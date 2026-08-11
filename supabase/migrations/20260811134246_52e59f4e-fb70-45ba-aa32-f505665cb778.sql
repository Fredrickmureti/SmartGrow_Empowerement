CREATE TABLE IF NOT EXISTS public.expense_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid,
  expense_id uuid NOT NULL REFERENCES public.expenses(id) ON DELETE CASCADE,
  storage_path text NOT NULL,
  file_name text,
  content_type text,
  size_bytes bigint,
  kind text NOT NULL DEFAULT 'receipt',
  uploaded_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_expense_attachments_expense ON public.expense_attachments(expense_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_expense_attachments_path ON public.expense_attachments(expense_id, storage_path);

GRANT SELECT, INSERT, DELETE ON public.expense_attachments TO authenticated;
GRANT ALL ON public.expense_attachments TO service_role;

ALTER TABLE public.expense_attachments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Org members read expense attachments"
  ON public.expense_attachments FOR SELECT TO authenticated
  USING (
    public.user_can_access_business(auth.uid(), business_id)
    AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'purchases', 'read')
  );

CREATE POLICY "Org members attach receipts to open expenses"
  ON public.expense_attachments FOR INSERT TO authenticated
  WITH CHECK (
    public.user_can_access_business(auth.uid(), business_id)
    AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'purchases', 'write')
    AND EXISTS (
      SELECT 1 FROM public.expenses e
      WHERE e.id = expense_id
        AND e.organization_id = expense_attachments.organization_id
        AND e.status::text IN ('draft', 'pending', 'submitted', 'rejected')
    )
  );

CREATE POLICY "Org members remove receipts from open expenses"
  ON public.expense_attachments FOR DELETE TO authenticated
  USING (
    public.user_can_access_business(auth.uid(), business_id)
    AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'purchases', 'write')
    AND EXISTS (
      SELECT 1 FROM public.expenses e
      WHERE e.id = expense_id
        AND e.status::text IN ('draft', 'pending', 'submitted', 'rejected')
    )
  );

CREATE TRIGGER trg_expense_attachments_updated_at
  BEFORE UPDATE ON public.expense_attachments
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();