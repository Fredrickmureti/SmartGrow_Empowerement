CREATE TABLE public.mf_clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES public.branches(id),
  client_number text NOT NULL,
  full_name text NOT NULL,
  national_id text,
  date_of_birth date,
  gender text CHECK (gender IN ('female','male','other')),
  phone text,
  email text,
  physical_address text,
  occupation text,
  business_type text,
  business_location text,
  photo_url text,
  next_of_kin_name text,
  next_of_kin_relationship text,
  next_of_kin_phone text,
  loan_officer_id uuid,
  joined_on date NOT NULL DEFAULT CURRENT_DATE,
  status text NOT NULL DEFAULT 'prospect'
    CHECK (status IN ('prospect','active','dormant','exited','blacklisted')),
  completed_cycles integer NOT NULL DEFAULT 0 CHECK (completed_cycles >= 0),
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX mf_clients_number_unique
  ON public.mf_clients (business_id, lower(client_number));
CREATE INDEX mf_clients_branch_idx ON public.mf_clients (business_id, branch_id);
CREATE INDEX mf_clients_officer_idx ON public.mf_clients (business_id, loan_officer_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.mf_clients TO authenticated;
GRANT ALL ON public.mf_clients TO service_role;

ALTER TABLE public.mf_clients ENABLE ROW LEVEL SECURITY;

CREATE POLICY "mf_clients_read" ON public.mf_clients
  FOR SELECT TO authenticated
  USING (public.user_has_business_access(auth.uid(), business_id));

CREATE POLICY "mf_clients_insert" ON public.mf_clients
  FOR INSERT TO authenticated
  WITH CHECK (
    public.user_has_business_access(auth.uid(), business_id)
    AND (
      public.has_role(auth.uid(), 'super_admin')
      OR public.has_role(auth.uid(), 'admin')
      OR public.has_role(auth.uid(), 'branch_manager')
      OR public.has_role(auth.uid(), 'loan_officer')
      OR public.has_role(auth.uid(), 'credit_officer')
    )
  );

CREATE POLICY "mf_clients_update" ON public.mf_clients
  FOR UPDATE TO authenticated
  USING (
    public.user_has_business_access(auth.uid(), business_id)
    AND (
      public.has_role(auth.uid(), 'super_admin')
      OR public.has_role(auth.uid(), 'admin')
      OR public.has_role(auth.uid(), 'branch_manager')
      OR public.has_role(auth.uid(), 'loan_officer')
      OR public.has_role(auth.uid(), 'credit_officer')
    )
  )
  WITH CHECK (public.user_has_business_access(auth.uid(), business_id));

CREATE POLICY "mf_clients_delete" ON public.mf_clients
  FOR DELETE TO authenticated
  USING (
    public.user_has_business_access(auth.uid(), business_id)
    AND (public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'admin'))
  );

CREATE TRIGGER mf_clients_touch
  BEFORE UPDATE ON public.mf_clients
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();