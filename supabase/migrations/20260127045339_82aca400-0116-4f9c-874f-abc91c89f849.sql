-- Add source_lead_id to estimates table
ALTER TABLE estimates 
ADD COLUMN source_lead_id UUID REFERENCES crm_leads(id) ON DELETE SET NULL;

-- Add source_lead_id to sales_orders table  
ALTER TABLE sales_orders 
ADD COLUMN source_lead_id UUID REFERENCES crm_leads(id) ON DELETE SET NULL;

-- Create indexes for performance
CREATE INDEX idx_estimates_source_lead ON estimates(source_lead_id) 
WHERE source_lead_id IS NOT NULL;

CREATE INDEX idx_sales_orders_source_lead ON sales_orders(source_lead_id) 
WHERE source_lead_id IS NOT NULL;