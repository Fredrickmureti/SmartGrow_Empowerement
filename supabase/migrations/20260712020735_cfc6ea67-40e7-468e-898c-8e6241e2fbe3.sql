
-- Add a structured `xlsx` writer to the format registry so certificate
-- templates can declare an editable Excel companion rendered from the
-- same v2 sections as the PDF. This is the Odoo model: PDF is authoritative,
-- XLSX is the editable twin — both derive from the same declarative template.
-- The existing `xlsx_binary` writer (master-workbook overlay) stays for
-- packs that still use it.

-- 1) Widen the writer check constraint.
ALTER TABLE public.format_registry
  DROP CONSTRAINT IF EXISTS format_registry_writer_check;
ALTER TABLE public.format_registry
  ADD CONSTRAINT format_registry_writer_check
  CHECK (writer IN ('csv','pdf','gov_csv','gov_xlsx','gov_xml','xlsx','xlsx_binary','xml'));

-- 2) Register the new structured Excel format.
INSERT INTO public.format_registry (format, label, mime, ext, role_hint, writer)
VALUES ('xlsx',
        'Excel (editable)',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'xlsx',
        'human_readable',
        'xlsx')
ON CONFLICT (format) DO UPDATE
  SET label     = EXCLUDED.label,
      mime      = EXCLUDED.mime,
      ext       = EXCLUDED.ext,
      role_hint = EXCLUDED.role_hint,
      writer    = EXCLUDED.writer;
