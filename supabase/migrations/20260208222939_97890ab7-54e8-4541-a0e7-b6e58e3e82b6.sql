
-- Add business_id column to crm_stages
ALTER TABLE public.crm_stages
  ADD COLUMN business_id UUID REFERENCES businesses(id);

-- Add business_id column to crm_activities
ALTER TABLE public.crm_activities
  ADD COLUMN business_id UUID REFERENCES businesses(id);

-- Backfill existing stage record
UPDATE public.crm_stages
SET business_id = 'a6b5772c-02b3-4adc-97d8-2707a94b55b4'
WHERE organization_id = 'a2b62719-2f78-4ceb-b851-edc74f70c324'
  AND business_id IS NULL;
