-- Fix search_path for functions created in previous migration
CREATE OR REPLACE FUNCTION public.update_document_templates_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE OR REPLACE FUNCTION public.ensure_single_default_template()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.is_default = true THEN
    UPDATE public.document_templates
    SET is_default = false
    WHERE id != NEW.id
      AND organization_id = NEW.organization_id
      AND template_type = NEW.template_type
      AND is_default = true
      AND (
        (NEW.business_id IS NULL AND business_id IS NULL)
        OR (NEW.business_id IS NOT NULL AND business_id = NEW.business_id)
      );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;