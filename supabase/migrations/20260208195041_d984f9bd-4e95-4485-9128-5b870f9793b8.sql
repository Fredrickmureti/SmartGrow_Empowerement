-- Create a function to automatically create a default "Headquarters" branch when a new business is created
CREATE OR REPLACE FUNCTION public.create_default_branch_for_business()
RETURNS TRIGGER AS $$
BEGIN
  -- Insert a default headquarters branch for the newly created business
  INSERT INTO public.branches (
    organization_id,
    business_id,
    name,
    code,
    is_headquarters,
    is_active
  ) VALUES (
    NEW.organization_id,
    NEW.id,
    'Headquarters',
    'HQ',
    true,
    true
  );
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Create trigger to fire after a new business is inserted
DROP TRIGGER IF EXISTS trigger_create_default_branch ON public.businesses;
CREATE TRIGGER trigger_create_default_branch
  AFTER INSERT ON public.businesses
  FOR EACH ROW
  EXECUTE FUNCTION public.create_default_branch_for_business();

-- Migrate orphan records with NULL business_id to the first active business in their org
-- Update invoices
UPDATE public.invoices i
SET business_id = (
  SELECT b.id FROM public.businesses b 
  WHERE b.organization_id = i.organization_id 
  AND b.is_active = true 
  ORDER BY b.created_at 
  LIMIT 1
)
WHERE i.business_id IS NULL
AND EXISTS (
  SELECT 1 FROM public.businesses b 
  WHERE b.organization_id = i.organization_id 
  AND b.is_active = true
);

-- Update contacts
UPDATE public.contacts c
SET business_id = (
  SELECT b.id FROM public.businesses b 
  WHERE b.organization_id = c.organization_id 
  AND b.is_active = true 
  ORDER BY b.created_at 
  LIMIT 1
)
WHERE c.business_id IS NULL
AND EXISTS (
  SELECT 1 FROM public.businesses b 
  WHERE b.organization_id = c.organization_id 
  AND b.is_active = true
);

-- Update expenses
UPDATE public.expenses e
SET business_id = (
  SELECT b.id FROM public.businesses b 
  WHERE b.organization_id = e.organization_id 
  AND b.is_active = true 
  ORDER BY b.created_at 
  LIMIT 1
)
WHERE e.business_id IS NULL
AND EXISTS (
  SELECT 1 FROM public.businesses b 
  WHERE b.organization_id = e.organization_id 
  AND b.is_active = true
);

-- Update bills
UPDATE public.bills bl
SET business_id = (
  SELECT b.id FROM public.businesses b 
  WHERE b.organization_id = bl.organization_id 
  AND b.is_active = true 
  ORDER BY b.created_at 
  LIMIT 1
)
WHERE bl.business_id IS NULL
AND EXISTS (
  SELECT 1 FROM public.businesses b 
  WHERE b.organization_id = bl.organization_id 
  AND b.is_active = true
);

-- Update payments
UPDATE public.payments p
SET business_id = (
  SELECT b.id FROM public.businesses b 
  WHERE b.organization_id = p.organization_id 
  AND b.is_active = true 
  ORDER BY b.created_at 
  LIMIT 1
)
WHERE p.business_id IS NULL
AND EXISTS (
  SELECT 1 FROM public.businesses b 
  WHERE b.organization_id = p.organization_id 
  AND b.is_active = true
);

-- Update products
UPDATE public.products pr
SET business_id = (
  SELECT b.id FROM public.businesses b 
  WHERE b.organization_id = pr.organization_id 
  AND b.is_active = true 
  ORDER BY b.created_at 
  LIMIT 1
)
WHERE pr.business_id IS NULL
AND EXISTS (
  SELECT 1 FROM public.businesses b 
  WHERE b.organization_id = pr.organization_id 
  AND b.is_active = true
);

-- Update sales_orders
UPDATE public.sales_orders so
SET business_id = (
  SELECT b.id FROM public.businesses b 
  WHERE b.organization_id = so.organization_id 
  AND b.is_active = true 
  ORDER BY b.created_at 
  LIMIT 1
)
WHERE so.business_id IS NULL
AND EXISTS (
  SELECT 1 FROM public.businesses b 
  WHERE b.organization_id = so.organization_id 
  AND b.is_active = true
);

-- Update purchase_orders
UPDATE public.purchase_orders po
SET business_id = (
  SELECT b.id FROM public.businesses b 
  WHERE b.organization_id = po.organization_id 
  AND b.is_active = true 
  ORDER BY b.created_at 
  LIMIT 1
)
WHERE po.business_id IS NULL
AND EXISTS (
  SELECT 1 FROM public.businesses b 
  WHERE b.organization_id = po.organization_id 
  AND b.is_active = true
);