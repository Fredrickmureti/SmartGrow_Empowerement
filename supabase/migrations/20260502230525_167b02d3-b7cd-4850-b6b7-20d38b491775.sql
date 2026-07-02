ALTER TABLE public.email_templates ALTER COLUMN business_id DROP NOT NULL;
SELECT public.ensure_default_email_templates(id) FROM public.organizations;