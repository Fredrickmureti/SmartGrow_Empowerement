-- One-time data fix: set the existing invoice template to is_default = true
-- so the toggle and document generation can find it
UPDATE document_templates 
SET is_default = true, updated_at = now() 
WHERE id = 'fb82b5ff-15a1-420f-86a3-7c6e207c2be8' 
  AND template_type = 'invoice' 
  AND is_default = false;