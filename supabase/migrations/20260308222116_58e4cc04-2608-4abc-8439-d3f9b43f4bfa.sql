-- Drop the old unique constraint that's too broad (org + code only)
ALTER TABLE public.accounts DROP CONSTRAINT IF EXISTS accounts_organization_id_code_key;

-- Add a new unique constraint scoped to business (allows same code across different businesses)
CREATE UNIQUE INDEX accounts_org_business_code_key ON public.accounts (organization_id, COALESCE(business_id, '00000000-0000-0000-0000-000000000000'), code);