INSERT INTO public.document_kinds (code, label, domain, legal_class, requires_party, default_media_class, default_intents, allowed_formats, is_active)
VALUES ('purchases.grn', 'Goods Received Note', 'purchases', 'operational', false, 'a4_portrait', ARRAY['view','download','email','print'], ARRAY['pdf'], true)
ON CONFLICT (code) DO NOTHING;