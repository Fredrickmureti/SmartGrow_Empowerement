
-- 1. Backfill business prefixes from organizations
UPDATE businesses b
SET
  invoice_prefix  = COALESCE(NULLIF(b.invoice_prefix, ''),  o.invoice_prefix,  'INV'),
  estimate_prefix = COALESCE(NULLIF(b.estimate_prefix, ''), o.estimate_prefix, 'EST'),
  bill_prefix     = COALESCE(NULLIF(b.bill_prefix, ''),     o.bill_prefix,     'BILL')
FROM organizations o
WHERE b.organization_id = o.id;

-- 2. Drop duplicate prefix columns from organizations
ALTER TABLE organizations
  DROP COLUMN IF EXISTS invoice_prefix,
  DROP COLUMN IF EXISTS estimate_prefix,
  DROP COLUMN IF EXISTS bill_prefix,
  DROP COLUMN IF EXISTS credit_note_prefix;

-- 3. Re-scope invoice_sequences to business
ALTER TABLE invoice_sequences
  ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES businesses(id) ON DELETE CASCADE;

UPDATE invoice_sequences s
SET business_id = b.id
FROM (
  SELECT DISTINCT ON (organization_id) id, organization_id
  FROM businesses
  WHERE is_active = true
  ORDER BY organization_id, created_at ASC
) b
WHERE s.organization_id = b.organization_id
  AND s.business_id IS NULL;

ALTER TABLE invoice_sequences
  DROP CONSTRAINT IF EXISTS invoice_sequences_organization_id_year_key;

CREATE UNIQUE INDEX IF NOT EXISTS invoice_sequences_business_year_uidx
  ON invoice_sequences (business_id, year)
  WHERE business_id IS NOT NULL;

-- 4. Re-scope je_number_sequences to business
ALTER TABLE je_number_sequences
  ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES businesses(id) ON DELETE CASCADE;

UPDATE je_number_sequences s
SET business_id = b.id
FROM (
  SELECT DISTINCT ON (organization_id) id, organization_id
  FROM businesses
  WHERE is_active = true
  ORDER BY organization_id, created_at ASC
) b
WHERE s.organization_id = b.organization_id
  AND s.business_id IS NULL;

ALTER TABLE je_number_sequences
  DROP CONSTRAINT IF EXISTS je_number_sequences_organization_id_key;
ALTER TABLE je_number_sequences
  DROP CONSTRAINT IF EXISTS je_number_sequences_pkey;

CREATE UNIQUE INDEX IF NOT EXISTS je_number_sequences_business_uidx
  ON je_number_sequences (business_id)
  WHERE business_id IS NOT NULL;

-- Re-add a primary key (id) if removed; many tables use id pk. If not present add a surrogate.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='je_number_sequences' AND column_name='id'
  ) THEN
    ALTER TABLE je_number_sequences ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid=c.conrelid
    WHERE t.relname='je_number_sequences' AND c.contype='p'
  ) THEN
    ALTER TABLE je_number_sequences ADD PRIMARY KEY (id);
  END IF;
END$$;
