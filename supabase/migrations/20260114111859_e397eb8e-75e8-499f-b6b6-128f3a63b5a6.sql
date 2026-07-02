-- Create table for estimate additional costs
CREATE TABLE public.estimate_additional_costs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  estimate_id UUID NOT NULL REFERENCES public.estimates(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  amount NUMERIC NOT NULL DEFAULT 0,
  is_taxable BOOLEAN DEFAULT false,
  tax_rate NUMERIC DEFAULT 0,
  tax_amount NUMERIC DEFAULT 0,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create table for invoice additional costs
CREATE TABLE public.invoice_additional_costs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  invoice_id UUID NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  amount NUMERIC NOT NULL DEFAULT 0,
  is_taxable BOOLEAN DEFAULT false,
  tax_rate NUMERIC DEFAULT 0,
  tax_amount NUMERIC DEFAULT 0,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS on both tables
ALTER TABLE public.estimate_additional_costs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_additional_costs ENABLE ROW LEVEL SECURITY;

-- RLS policies for estimate_additional_costs
CREATE POLICY "Users can view estimate additional costs for their organization"
ON public.estimate_additional_costs
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM public.estimates e
    JOIN public.user_roles ur ON ur.organization_id = e.organization_id
    WHERE e.id = estimate_additional_costs.estimate_id
    AND ur.user_id = auth.uid()
    AND ur.is_active = true
  )
);

CREATE POLICY "Users can create estimate additional costs for their organization"
ON public.estimate_additional_costs
FOR INSERT
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.estimates e
    JOIN public.user_roles ur ON ur.organization_id = e.organization_id
    WHERE e.id = estimate_additional_costs.estimate_id
    AND ur.user_id = auth.uid()
    AND ur.is_active = true
  )
);

CREATE POLICY "Users can update estimate additional costs for their organization"
ON public.estimate_additional_costs
FOR UPDATE
USING (
  EXISTS (
    SELECT 1 FROM public.estimates e
    JOIN public.user_roles ur ON ur.organization_id = e.organization_id
    WHERE e.id = estimate_additional_costs.estimate_id
    AND ur.user_id = auth.uid()
    AND ur.is_active = true
  )
);

CREATE POLICY "Users can delete estimate additional costs for their organization"
ON public.estimate_additional_costs
FOR DELETE
USING (
  EXISTS (
    SELECT 1 FROM public.estimates e
    JOIN public.user_roles ur ON ur.organization_id = e.organization_id
    WHERE e.id = estimate_additional_costs.estimate_id
    AND ur.user_id = auth.uid()
    AND ur.is_active = true
  )
);

-- RLS policies for invoice_additional_costs
CREATE POLICY "Users can view invoice additional costs for their organization"
ON public.invoice_additional_costs
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM public.invoices i
    JOIN public.user_roles ur ON ur.organization_id = i.organization_id
    WHERE i.id = invoice_additional_costs.invoice_id
    AND ur.user_id = auth.uid()
    AND ur.is_active = true
  )
);

CREATE POLICY "Users can create invoice additional costs for their organization"
ON public.invoice_additional_costs
FOR INSERT
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.invoices i
    JOIN public.user_roles ur ON ur.organization_id = i.organization_id
    WHERE i.id = invoice_additional_costs.invoice_id
    AND ur.user_id = auth.uid()
    AND ur.is_active = true
  )
);

CREATE POLICY "Users can update invoice additional costs for their organization"
ON public.invoice_additional_costs
FOR UPDATE
USING (
  EXISTS (
    SELECT 1 FROM public.invoices i
    JOIN public.user_roles ur ON ur.organization_id = i.organization_id
    WHERE i.id = invoice_additional_costs.invoice_id
    AND ur.user_id = auth.uid()
    AND ur.is_active = true
  )
);

CREATE POLICY "Users can delete invoice additional costs for their organization"
ON public.invoice_additional_costs
FOR DELETE
USING (
  EXISTS (
    SELECT 1 FROM public.invoices i
    JOIN public.user_roles ur ON ur.organization_id = i.organization_id
    WHERE i.id = invoice_additional_costs.invoice_id
    AND ur.user_id = auth.uid()
    AND ur.is_active = true
  )
);

-- Create indexes for better performance
CREATE INDEX idx_estimate_additional_costs_estimate_id ON public.estimate_additional_costs(estimate_id);
CREATE INDEX idx_invoice_additional_costs_invoice_id ON public.invoice_additional_costs(invoice_id);