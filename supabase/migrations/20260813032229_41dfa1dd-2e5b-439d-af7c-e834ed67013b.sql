INSERT INTO public.document_template_ast (kind_code, scope, label, version, is_active, is_default, media_class, ast)
SELECT 'purchases.statement', 'system', 'System default — Vendor Statement', 1, true, true, 'a4_portrait',
  jsonb_build_object(
    'kind', 'purchases.statement',
    'version', 1,
    'media_class', 'a4_portrait',
    'blocks', jsonb_build_array(
      jsonb_build_object('type','header','variant','branded'),
      jsonb_build_object('type','party','role','supplier'),
      jsonb_build_object('type','meta','fields', jsonb_build_array('number','date','currency')),
      jsonb_build_object('type','table','preset','line_items'),
      jsonb_build_object('type','totals','preset','standard'),
      jsonb_build_object('type','notes','source','terms'),
      jsonb_build_object('type','footer','variant','branded')
    )
  )
WHERE NOT EXISTS (
  SELECT 1 FROM public.document_template_ast
  WHERE kind_code = 'purchases.statement' AND scope = 'system'
);