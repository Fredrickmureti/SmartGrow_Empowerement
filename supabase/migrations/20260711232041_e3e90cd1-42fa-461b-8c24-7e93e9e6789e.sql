
-- PART A: pack-declared export formats + per-run artifact registry
-- Non-breaking: adds `artifacts jsonb` alongside legacy csv_path/pdf_path/gov_file_path
-- so consumers can migrate to the canonical list. Legacy columns remain populated
-- by the generator for one release, then the follow-up agent will drop them.

-- ---------------------------------------------------------------------------
-- 1) format_registry — canonical whitelist of pack output formats.
--    Publishers pick from this table; generators dispatch on it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.format_registry (
  format text PRIMARY KEY,
  label  text NOT NULL,
  mime   text NOT NULL,
  ext    text NOT NULL,
  role_hint text NOT NULL CHECK (role_hint IN ('primary','human_readable','audit','portal')),
  writer text NOT NULL CHECK (writer IN ('csv','pdf','gov_csv','gov_xlsx','gov_xml','xlsx_binary','xml')),
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.format_registry TO anon, authenticated;
GRANT ALL    ON public.format_registry TO service_role;

ALTER TABLE public.format_registry ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "format_registry readable" ON public.format_registry;
CREATE POLICY "format_registry readable" ON public.format_registry FOR SELECT USING (true);

INSERT INTO public.format_registry (format, label, mime, ext, role_hint, writer) VALUES
  ('csv',         'CSV',                   'text/csv',                                                                'csv',       'audit',          'csv'),
  ('pdf',         'PDF',                   'application/pdf',                                                         'pdf',       'human_readable', 'pdf'),
  ('gov_csv',     'Gov CSV (portal)',      'text/csv',                                                                'gov.csv',   'portal',         'gov_csv'),
  ('gov_xlsx',    'Gov Excel (portal)',    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',       'gov.xlsx',  'portal',         'gov_xlsx'),
  ('gov_xml',     'Gov XML (portal)',      'application/xml',                                                         'gov.xml',   'portal',         'gov_xml'),
  ('xlsx_binary', 'Excel (bound master)',  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',       'xlsx',      'primary',        'xlsx_binary'),
  ('xml',         'XML',                   'application/xml',                                                         'xml',       'primary',        'xml')
ON CONFLICT (format) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2) `outputs jsonb` on both template tables. Nullable; when null the
--    generator falls back to the legacy `output`/`kind` scalar.
-- ---------------------------------------------------------------------------
ALTER TABLE public.localization_pack_return_templates
  ADD COLUMN IF NOT EXISTS outputs jsonb;

ALTER TABLE public.localization_pack_certificate_templates
  ADD COLUMN IF NOT EXISTS outputs jsonb;

COMMENT ON COLUMN public.localization_pack_return_templates.outputs IS
  'Pack-declared export formats. Array of {format,label?,role,filename?,mime?}. Each format must exist in public.format_registry.';
COMMENT ON COLUMN public.localization_pack_certificate_templates.outputs IS
  'Pack-declared export formats for the certificate. Same shape as return outputs. Falls back to `kind` when null.';

-- ---------------------------------------------------------------------------
-- 3) `artifacts jsonb` on payroll_return_runs — canonical per-run artifact list.
--    Shape: [{format,path,mime,ext,size,sha256?,role,generated_at}]
-- ---------------------------------------------------------------------------
ALTER TABLE public.payroll_return_runs
  ADD COLUMN IF NOT EXISTS artifacts jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.payroll_return_runs.artifacts IS
  'Canonical artifact list. Preferred over csv_path/pdf_path/gov_file_path (deprecated read-mirrors).';

-- Back-fill existing rows from the legacy path columns so the UI can switch
-- to `artifacts` without losing history.
UPDATE public.payroll_return_runs r
   SET artifacts = COALESCE(r.artifacts, '[]'::jsonb) ||
     COALESCE((
        SELECT jsonb_agg(x)
          FROM (
            SELECT jsonb_build_object(
                     'format','csv','path',r.csv_path,'mime','text/csv','ext','csv',
                     'role','audit','generated_at',r.generated_at
                   ) AS x
             WHERE r.csv_path IS NOT NULL
            UNION ALL
            SELECT jsonb_build_object(
                     'format','pdf','path',r.pdf_path,'mime','application/pdf','ext','pdf',
                     'role','human_readable','generated_at',r.generated_at
                   )
             WHERE r.pdf_path IS NOT NULL
            UNION ALL
            SELECT jsonb_build_object(
                     'format', CASE
                       WHEN r.gov_file_path ILIKE '%.gov.xlsx' THEN 'gov_xlsx'
                       WHEN r.gov_file_path ILIKE '%.gov.xml'  THEN 'gov_xml'
                       ELSE 'gov_csv'
                     END,
                     'path', r.gov_file_path,
                     'mime', CASE
                       WHEN r.gov_file_path ILIKE '%.gov.xlsx'
                         THEN 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
                       WHEN r.gov_file_path ILIKE '%.gov.xml' THEN 'application/xml'
                       ELSE 'text/csv'
                     END,
                     'ext', CASE
                       WHEN r.gov_file_path ILIKE '%.gov.xlsx' THEN 'gov.xlsx'
                       WHEN r.gov_file_path ILIKE '%.gov.xml'  THEN 'gov.xml'
                       ELSE 'gov.csv'
                     END,
                     'role','portal','generated_at',r.generated_at
                   )
             WHERE r.gov_file_path IS NOT NULL
          ) t
     ), '[]'::jsonb)
  WHERE r.artifacts = '[]'::jsonb
    AND (r.csv_path IS NOT NULL OR r.pdf_path IS NOT NULL OR r.gov_file_path IS NOT NULL);

-- ---------------------------------------------------------------------------
-- 4) Validation trigger — reject unknown formats in outputs[].format
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assert_outputs_formats_registered()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  bad_format text;
BEGIN
  IF NEW.outputs IS NULL OR jsonb_typeof(NEW.outputs) <> 'array' THEN
    RETURN NEW;
  END IF;
  SELECT (elem->>'format') INTO bad_format
    FROM jsonb_array_elements(NEW.outputs) elem
   WHERE NOT EXISTS (
     SELECT 1 FROM public.format_registry f WHERE f.format = elem->>'format'
   )
   LIMIT 1;
  IF bad_format IS NOT NULL THEN
    RAISE EXCEPTION
      'outputs contains unknown format %; add it to public.format_registry or remove it from the pack template.',
      bad_format
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_return_template_outputs_check ON public.localization_pack_return_templates;
CREATE TRIGGER trg_return_template_outputs_check
  BEFORE INSERT OR UPDATE OF outputs ON public.localization_pack_return_templates
  FOR EACH ROW EXECUTE FUNCTION public.assert_outputs_formats_registered();

DROP TRIGGER IF EXISTS trg_certificate_template_outputs_check ON public.localization_pack_certificate_templates;
CREATE TRIGGER trg_certificate_template_outputs_check
  BEFORE INSERT OR UPDATE OF outputs ON public.localization_pack_certificate_templates
  FOR EACH ROW EXECUTE FUNCTION public.assert_outputs_formats_registered();
