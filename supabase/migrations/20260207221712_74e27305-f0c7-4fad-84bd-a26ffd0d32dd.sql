-- Add document section placement for custom fields
ALTER TABLE entity_field_configs 
ADD COLUMN IF NOT EXISTS document_section text DEFAULT 'additional';

-- Add status badge toggle to document templates
ALTER TABLE document_templates 
ADD COLUMN IF NOT EXISTS show_status_badge boolean DEFAULT false;

-- Add comment for document_section values
COMMENT ON COLUMN entity_field_configs.document_section IS 'Controls where the field renders on printed documents: header, details, after_items, notes, footer, additional';