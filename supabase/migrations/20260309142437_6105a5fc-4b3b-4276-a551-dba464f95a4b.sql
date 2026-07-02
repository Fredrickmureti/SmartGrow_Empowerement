-- 1. Create sequence counter table
CREATE TABLE IF NOT EXISTS je_number_sequences (
  organization_id UUID PRIMARY KEY REFERENCES organizations(id),
  last_number INT NOT NULL DEFAULT 0
);

ALTER TABLE je_number_sequences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Org members can read sequences"
  ON je_number_sequences FOR SELECT TO authenticated
  USING (organization_id IN (
    SELECT get_user_organizations(auth.uid())
  ));

-- 2. Replace the broken generate_next_je_number function with atomic upsert
CREATE OR REPLACE FUNCTION generate_next_je_number(_org_id UUID)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_num INT;
BEGIN
  INSERT INTO je_number_sequences (organization_id, last_number)
  VALUES (_org_id, 1)
  ON CONFLICT (organization_id)
  DO UPDATE SET last_number = je_number_sequences.last_number + 1
  RETURNING last_number INTO v_num;

  RETURN 'JE-' || LPAD(v_num::TEXT, 5, '0');
END;
$$;

-- 3. Seed from existing journal entries so numbering continues
INSERT INTO je_number_sequences (organization_id, last_number)
SELECT organization_id, COALESCE(MAX(
  CASE WHEN entry_number ~ '^JE-[0-9]+$'
       THEN CAST(SUBSTRING(entry_number FROM 4) AS INT)
       ELSE 0 END
), 0)
FROM journal_entries
GROUP BY organization_id
ON CONFLICT (organization_id) DO UPDATE
SET last_number = GREATEST(je_number_sequences.last_number, EXCLUDED.last_number);