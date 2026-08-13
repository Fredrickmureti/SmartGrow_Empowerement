-- Phase 5C.3 — Landed Cost Voucher document profile.
--
-- A landed cost voucher is INTERNAL costing evidence: it proves how
-- shipment charges were spread over received goods and what was
-- capitalised vs expensed. It has no counterparty billing semantics
-- (no "Bill To", no amount due, no tax ladder), so the kind is
-- registered without an `email` intent and drawn by its own layout.
INSERT INTO public.document_kinds (
  code, label, domain, legal_class, default_media_class,
  default_intents, allowed_formats, requires_party, is_active
)
VALUES (
  'purchases.landed_cost_voucher', 'Landed Cost Voucher', 'purchases', 'internal', 'a4_portrait',
  ARRAY['view','download','print'], ARRAY['pdf'], false, true
)
ON CONFLICT (code) DO UPDATE
  SET label           = EXCLUDED.label,
      domain          = EXCLUDED.domain,
      legal_class     = EXCLUDED.legal_class,
      default_intents = EXCLUDED.default_intents,
      allowed_formats = EXCLUDED.allowed_formats,
      requires_party  = EXCLUDED.requires_party,
      is_active       = true;

INSERT INTO public.document_template_ast (
  kind_code, scope, version, label, is_default, is_active, media_class, ast
)
SELECT 'purchases.landed_cost_voucher', 'system', 1,
       'System default — Landed Cost Voucher', true, true, 'a4_portrait',
  jsonb_build_object(
    'kind', 'purchases.landed_cost_voucher',
    'version', 1,
    'media_class', 'a4_portrait',
    'layout', 'landed_cost_voucher',
    'blocks', jsonb_build_array(
      jsonb_build_object('type','header','variant','branded'),
      jsonb_build_object('type','meta','fields',
        jsonb_build_array('number','date','posting_date','status','shipment_reference',
                          'currency','exchange_rate','default_basis')),
      jsonb_build_object('type','notes','source','notes'),
      jsonb_build_object('type','table','preset','landed_cost_charges'),
      jsonb_build_object('type','table','preset','landed_cost_scope'),
      jsonb_build_object('type','table','preset','landed_cost_allocations'),
      jsonb_build_object('type','totals','preset','capitalized_expensed'),
      jsonb_build_object('type','table','preset','audit_trail'),
      jsonb_build_object('type','footer','variant','internal')
    )
  )
WHERE NOT EXISTS (
  SELECT 1 FROM public.document_template_ast
   WHERE kind_code = 'purchases.landed_cost_voucher' AND scope = 'system' AND is_default
);