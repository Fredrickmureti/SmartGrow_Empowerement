-- Fix NSSF Monthly Byproduct Return template: KRA PIN column addressed a
-- non-existent context key (`employee.tax_id`). The canonical identifier
-- projected onto the return context is `employee.tax_pin` (mirrors the
-- lowercased `employee_statutory_identifiers.identifier_type` value used
-- by every Kenya tenant). This single-cell change unblocks the KRA PIN
-- column for every already-approved period without any code deploy.
UPDATE public.localization_pack_return_templates
SET body = jsonb_set(
  body,
  '{columns}',
  (
    SELECT jsonb_agg(
      CASE
        WHEN col->>'key' = 'kra_pin'
          THEN jsonb_set(col, '{source}', '"employee.tax_pin"'::jsonb)
        ELSE col
      END
    )
    FROM jsonb_array_elements(body->'columns') AS col
  )
),
updated_at = now()
WHERE code = 'NSSF_RET';