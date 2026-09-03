INSERT INTO public.document_kinds (code, label, domain, legal_class, default_media_class, default_intents, allowed_formats, requires_party, is_active)
VALUES
  ('lending.client_statement', 'Client Statement', 'lending', 'informational', 'a4_portrait', ARRAY['view','download','print','email'], ARRAY['pdf'], true, true)
ON CONFLICT (code) DO NOTHING;

INSERT INTO public.document_template_ast (kind_code, scope, version, label, is_default, is_active, media_class, ast)
SELECT k.code, 'system', 1, 'System default — ' || k.label, true, true, 'a4_portrait',
  jsonb_build_object(
    'kind', k.code,
    'version', 1,
    'media_class', 'a4_portrait',
    'layout', split_part(k.code, '.', 2),
    'blocks', jsonb_build_array(
      jsonb_build_object('type','header','variant','branded'),
      jsonb_build_object('type','footer','variant','branded')
    )
  )
FROM public.document_kinds k
WHERE k.code = 'lending.client_statement'
  AND NOT EXISTS (
    SELECT 1 FROM public.document_template_ast t
     WHERE t.kind_code = k.code AND t.scope = 'system' AND t.is_default
  );