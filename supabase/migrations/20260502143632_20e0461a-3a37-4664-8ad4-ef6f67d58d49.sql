
CREATE TABLE public.default_account_mapping_audit (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL,
  business_id           uuid,
  role_key              text NOT NULL,
  previous_account_id   uuid,
  new_account_id        uuid,
  action                text NOT NULL CHECK (action IN ('auto_mapped','manual','cleared','preserved','rejected')),
  confidence            text CHECK (confidence IN ('exact','strong','weak','none')),
  score                 numeric,
  reason                text,
  batch_id              uuid,
  performed_by          uuid,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_default_account_mapping_audit_org_business
  ON public.default_account_mapping_audit (organization_id, business_id, created_at DESC);
CREATE INDEX idx_default_account_mapping_audit_role
  ON public.default_account_mapping_audit (role_key, created_at DESC);
CREATE INDEX idx_default_account_mapping_audit_batch
  ON public.default_account_mapping_audit (batch_id);

ALTER TABLE public.default_account_mapping_audit ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Org members can read mapping audit"
  ON public.default_account_mapping_audit
  FOR SELECT
  TO authenticated
  USING (organization_id = ANY (public.get_user_organization_ids()));
