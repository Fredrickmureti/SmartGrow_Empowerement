
-- Add business_id to audit_logs table
ALTER TABLE public.audit_logs ADD COLUMN business_id uuid REFERENCES public.businesses(id);
CREATE INDEX idx_audit_logs_business_id ON public.audit_logs(business_id);

-- Add business_id to stock_movements table
ALTER TABLE public.stock_movements ADD COLUMN business_id uuid REFERENCES public.businesses(id);
CREATE INDEX idx_stock_movements_business_id ON public.stock_movements(business_id);
