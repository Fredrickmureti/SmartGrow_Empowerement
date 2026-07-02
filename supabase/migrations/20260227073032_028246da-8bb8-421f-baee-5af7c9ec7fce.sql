-- Clean stale payment method ID from template fb82b5ff
UPDATE document_templates 
SET payment_method_ids = ARRAY['82ee417d-ed2f-48f3-8c27-1874d8b40a86']::uuid[]
WHERE id = 'fb82b5ff-15a1-420f-86a3-7c6e207c2be8';