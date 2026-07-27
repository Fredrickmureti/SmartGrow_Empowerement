
-- Phase 1: extend document_print_policies with unified routing fields.
-- Old columns (auto_print, device_assignment_id, render_mode) intentionally
-- kept for one release so the current resolver keeps returning results
-- while Phase 2 rewires submit-document-intent + dispatch-print-jobs.

DO $$ BEGIN
  CREATE TYPE public.document_output_trigger AS ENUM (
    'manual',        -- user clicks Print; opens preview or dispatches
    'auto',          -- fire immediately on document commit (POS receipts, kitchen tickets)
    'preview_only',  -- never auto-dispatch; force operator confirmation
    'download_only'  -- PDF download, never routed to a physical device
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE public.document_print_policies
  ADD COLUMN IF NOT EXISTS trigger public.document_output_trigger NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS role_code text NULL;

COMMENT ON COLUMN public.document_print_policies.trigger IS
  'When this document should reach a device. Replaces the boolean auto_print flag with an explicit enum so preview/download semantics are first-class.';
COMMENT ON COLUMN public.document_print_policies.role_code IS
  'Semantic printer role (see printer_roles.code) that handles this document. Physical device is chosen at runtime by printer_role_branch_bindings.';

-- Backfill trigger from legacy auto_print flag.
UPDATE public.document_print_policies
SET trigger = 'auto'
WHERE auto_print = true AND trigger = 'manual';

-- Backfill role_code from document_type heuristic. These match the
-- five is_system printer_roles seeded per organization.
UPDATE public.document_print_policies
SET role_code = CASE
  WHEN document_type IN ('pos_receipt') THEN 'receipt_thermal'
  WHEN document_type IN ('kitchen_ticket', 'bar_ticket') THEN 'kitchen'
  WHEN document_type LIKE '%label%' OR document_type IN ('shipping_label', 'product_label') THEN 'label_zpl'
  WHEN document_type IN ('invoice', 'credit_note', 'receipt', 'proforma', 'customer_statement', 'vendor_statement') THEN 'fiscal_a4'
  ELSE 'back_office'
END
WHERE role_code IS NULL;
