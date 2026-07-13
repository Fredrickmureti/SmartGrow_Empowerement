-- 1) Copy the working body from P9 into P9A (same pack scope).
UPDATE public.localization_pack_certificate_templates AS p9a
   SET body = p9.body,
       display_name = 'P9A — Tax Deduction Card',
       revision_notes = COALESCE(p9a.revision_notes,'') ||
         E'\n[' || to_char(now(),'YYYY-MM-DD') || '] Consolidated onto the KRA single-P9A layout: adopted the fully-mapped A–O body (source_keys + derived columns) previously carried by the P9 template. Legacy P9 template retired in the same migration.'
  FROM public.localization_pack_certificate_templates AS p9
 WHERE p9a.code = 'P9A'
   AND p9.code  = 'P9'
   AND p9.pack_id = p9a.pack_id;

-- 2) Retire the legacy P9 template. Only delete if nothing references it;
--    otherwise mark it disabled by clearing the pack scope is not an option,
--    so we hard-delete and rely on the certificate_templates FK cascade.
DELETE FROM public.localization_pack_certificate_templates
 WHERE code = 'P9';