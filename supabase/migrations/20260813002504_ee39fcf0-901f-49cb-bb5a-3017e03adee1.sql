-- Journal Voucher: printable single journal entry (internal accounting artefact).
INSERT INTO public.document_kinds (
  code, label, domain, legal_class, default_media_class,
  default_intents, allowed_formats, requires_party, is_active
)
VALUES (
  'finance.journal_entry', 'Journal Voucher', 'finance', 'internal', 'a4_portrait',
  -- NO 'email' intent: a journal voucher is internal accounting evidence,
  -- never correspondence to a counterparty.
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
SELECT 'finance.journal_entry', 'system', 1,
       'System default — Journal Voucher', true, true, 'a4_portrait',
  jsonb_build_object(
    'kind', 'finance.journal_entry',
    'version', 1,
    'media_class', 'a4_portrait',
    'layout', 'journal_voucher',
    'blocks', jsonb_build_array(
      jsonb_build_object('type','header','variant','branded'),
      jsonb_build_object('type','meta','fields',
        jsonb_build_array('number','date','period','journal_book','status',
                          'source','reference','currency','flags')),
      jsonb_build_object('type','notes','source','narration'),
      jsonb_build_object('type','table','preset','ledger_lines'),
      jsonb_build_object('type','totals','preset','debit_credit_balance'),
      jsonb_build_object('type','table','preset','audit_trail'),
      jsonb_build_object('type','footer','variant','internal')
    )
  )
WHERE NOT EXISTS (
  SELECT 1 FROM public.document_template_ast
   WHERE kind_code = 'finance.journal_entry' AND scope = 'system' AND is_default
);