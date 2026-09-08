CREATE TABLE public.mf_client_fee_policy (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  business_id uuid NOT NULL UNIQUE,
  admission_fee_amount numeric(18,2),
  admission_fee_currency text,
  admission_fee_active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.mf_client_fee_policy IS
  'Institution-level client-charge configuration. The ASA Kenya member admission fee is a one-time, per-client institution income charge. No amount is hardcoded anywhere: when admission_fee_active is false or the amount is null, no admission fee exists.';

GRANT SELECT, INSERT, UPDATE, DELETE ON public.mf_client_fee_policy TO authenticated;
GRANT ALL ON public.mf_client_fee_policy TO service_role;

ALTER TABLE public.mf_client_fee_policy ENABLE ROW LEVEL SECURITY;

CREATE POLICY mf_client_fee_policy_read ON public.mf_client_fee_policy
  FOR SELECT TO authenticated
  USING (public.mf_can(business_id, NULL::uuid, 'accounting', 'read'));

CREATE POLICY mf_client_fee_policy_write ON public.mf_client_fee_policy
  FOR ALL TO authenticated
  USING (public.mf_can(business_id, NULL::uuid, 'accounting', 'write'))
  WITH CHECK (public.mf_can(business_id, NULL::uuid, 'accounting', 'write'));

CREATE TRIGGER mf_client_fee_policy_touch
  BEFORE UPDATE ON public.mf_client_fee_policy
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();