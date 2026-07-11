
-- PART A2: tax certificate artifacts registry (mirrors payroll_return_runs)
ALTER TABLE public.payroll_tax_certificates
  ADD COLUMN IF NOT EXISTS artifacts jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.payroll_tax_certificates.artifacts IS
  'Canonical artifact list. Shape: [{format,path,mime,ext,size?,sha256?,role,generated_at}]. Preferred over pdf_path/xlsx_path (deprecated read-mirrors).';

-- Back-fill existing rows from the legacy path scalars.
UPDATE public.payroll_tax_certificates c
   SET artifacts = COALESCE(c.artifacts, '[]'::jsonb) ||
     COALESCE((
        SELECT jsonb_agg(x)
          FROM (
            SELECT jsonb_build_object(
                     'format','pdf','path',c.pdf_path,'mime','application/pdf','ext','pdf',
                     'role','human_readable','generated_at',c.created_at
                   ) AS x
             WHERE c.pdf_path IS NOT NULL
            UNION ALL
            SELECT jsonb_build_object(
                     'format','xlsx_binary','path',c.xlsx_path,
                     'mime','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                     'ext','xlsx','role','primary','generated_at',c.created_at
                   )
             WHERE c.xlsx_path IS NOT NULL
          ) t
     ), '[]'::jsonb)
  WHERE c.artifacts = '[]'::jsonb
    AND (c.pdf_path IS NOT NULL OR c.xlsx_path IS NOT NULL);
