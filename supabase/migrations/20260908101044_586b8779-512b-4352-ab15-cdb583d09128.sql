CREATE TABLE public.mf_account_mapping_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid,
  branch_id uuid,
  mapping_key text NOT NULL,
  old_account_id uuid,
  new_account_id uuid,
  action text NOT NULL,
  changed_by uuid,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.mf_account_mapping_audit TO authenticated;
GRANT ALL ON public.mf_account_mapping_audit TO service_role;

ALTER TABLE public.mf_account_mapping_audit ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members can read mapping audit"
ON public.mf_account_mapping_audit FOR SELECT TO authenticated
USING (true);

-- Rollback:
-- DROP TABLE public.mf_account_mapping_audit;
