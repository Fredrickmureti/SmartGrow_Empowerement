-- Add image_url column to products table
ALTER TABLE public.products ADD COLUMN image_url TEXT;

-- Add receipt_number column to payments table for receipt tracking
ALTER TABLE public.payments ADD COLUMN receipt_number TEXT;

-- Add signature fields to estimates for customer acceptance
ALTER TABLE public.estimates ADD COLUMN customer_signature_url TEXT;
ALTER TABLE public.estimates ADD COLUMN signed_at TIMESTAMPTZ;
ALTER TABLE public.estimates ADD COLUMN signed_by_name TEXT;
ALTER TABLE public.estimates ADD COLUMN signed_by_email TEXT;

-- Add signature fields to invoices for payment confirmation
ALTER TABLE public.invoices ADD COLUMN customer_signature_url TEXT;
ALTER TABLE public.invoices ADD COLUMN signed_at TIMESTAMPTZ;

-- Create function to generate sequential receipt numbers per organization
CREATE OR REPLACE FUNCTION public.get_next_receipt_number(_org_id uuid)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _next_num INTEGER;
  _prefix TEXT;
BEGIN
  -- Get the count of existing receipts for this org and add 1
  SELECT COALESCE(MAX(
    CASE 
      WHEN receipt_number ~ '^RCP-[0-9]+$' 
      THEN CAST(SUBSTRING(receipt_number FROM 5) AS INTEGER)
      ELSE 0 
    END
  ), 0) + 1
  INTO _next_num
  FROM payments
  WHERE organization_id = _org_id AND receipt_number IS NOT NULL;
  
  RETURN 'RCP-' || LPAD(_next_num::TEXT, 6, '0');
END;
$$;

-- Create signatures storage bucket for digital signatures
INSERT INTO storage.buckets (id, name, public)
VALUES ('signatures', 'signatures', false)
ON CONFLICT (id) DO NOTHING;

-- RLS policy for signatures bucket - users can upload/view their org's signatures
CREATE POLICY "Users can upload signatures for their organization"
ON storage.objects FOR INSERT
WITH CHECK (
  bucket_id = 'signatures' AND
  auth.uid() IS NOT NULL
);

CREATE POLICY "Users can view signatures"
ON storage.objects FOR SELECT
USING (
  bucket_id = 'signatures' AND
  auth.uid() IS NOT NULL
);

-- Create product-images storage bucket
INSERT INTO storage.buckets (id, name, public)
VALUES ('product-images', 'product-images', true)
ON CONFLICT (id) DO NOTHING;

-- RLS policies for product-images bucket
CREATE POLICY "Anyone can view product images"
ON storage.objects FOR SELECT
USING (bucket_id = 'product-images');

CREATE POLICY "Authenticated users can upload product images"
ON storage.objects FOR INSERT
WITH CHECK (
  bucket_id = 'product-images' AND
  auth.uid() IS NOT NULL
);

CREATE POLICY "Authenticated users can update product images"
ON storage.objects FOR UPDATE
USING (
  bucket_id = 'product-images' AND
  auth.uid() IS NOT NULL
);

CREATE POLICY "Authenticated users can delete product images"
ON storage.objects FOR DELETE
USING (
  bucket_id = 'product-images' AND
  auth.uid() IS NOT NULL
);