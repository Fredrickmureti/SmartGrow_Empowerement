CREATE TABLE public.organization_ownership_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  from_user_id uuid NOT NULL,
  to_user_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  responded_at timestamptz,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organization_ownership_transfers_status_check
    CHECK (status IN ('pending','accepted','cancelled','expired')),
  CONSTRAINT organization_ownership_transfers_distinct_parties
    CHECK (from_user_id <> to_user_id)
);

CREATE UNIQUE INDEX organization_ownership_transfers_one_pending
  ON public.organization_ownership_transfers (organization_id)
  WHERE status = 'pending';

GRANT SELECT ON public.organization_ownership_transfers TO authenticated;
GRANT ALL ON public.organization_ownership_transfers TO service_role;

ALTER TABLE public.organization_ownership_transfers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owner and recipient can view ownership transfers"
  ON public.organization_ownership_transfers
  FOR SELECT TO authenticated
  USING (
    auth.uid() = from_user_id
    OR auth.uid() = to_user_id
    OR public.is_org_administrator(auth.uid(), organization_id)
  );

CREATE TRIGGER update_organization_ownership_transfers_updated_at
BEFORE UPDATE ON public.organization_ownership_transfers
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();