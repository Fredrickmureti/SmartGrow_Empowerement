-- W4b (ADR-0008): seed default POS receipt print policies.
-- Any business that already operates an active POS register should get a
-- sensible default of 80 mm / ESC/POS so the unified renderer routes
-- receipts to the thermal printer without operator setup. Manual
-- per-business / per-branch overrides remain authoritative because of
-- the unique index (business_id, COALESCE(branch_id,...), document_type).

INSERT INTO public.document_print_policies (
  business_id, branch_id, document_type, paper_format, render_mode,
  printer_profile_id, auto_print
)
SELECT DISTINCT r.business_id, NULL::uuid, 'pos_receipt', '80mm', 'escpos', NULL::uuid, false
FROM public.pos_registers r
WHERE r.is_active = true
  AND r.business_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.document_print_policies p
     WHERE p.business_id = r.business_id
       AND p.branch_id IS NULL
       AND p.document_type = 'pos_receipt'
  );

COMMENT ON COLUMN public.document_print_policies.printer_profile_id IS
  'Reserved for W6/W7 (printer profiles); no FK yet. Stage P5/W4b leaves NULL.';