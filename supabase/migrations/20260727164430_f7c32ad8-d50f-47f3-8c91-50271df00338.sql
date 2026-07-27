INSERT INTO public.document_kinds
  (code, label, domain, legal_class, default_media_class, default_intents, allowed_formats, requires_party)
VALUES
  ('hr.promotion_letter', 'Promotion Letter', 'hr', 'contractual', 'a4_portrait', ARRAY['view','download','email'], ARRAY['pdf'], true),
  ('hr.warning_letter',   'Warning Letter',   'hr', 'contractual', 'a4_portrait', ARRAY['view','download','email'], ARRAY['pdf'], true)
ON CONFLICT (code) DO NOTHING;