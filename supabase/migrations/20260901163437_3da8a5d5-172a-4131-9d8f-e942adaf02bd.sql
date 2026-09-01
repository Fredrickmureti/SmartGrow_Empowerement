CREATE TABLE public.mf_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES public.branches(id),
  group_number text NOT NULL,
  name text NOT NULL,
  loan_officer_id uuid,
  meeting_day smallint CHECK (meeting_day BETWEEN 0 AND 6),
  meeting_time time,
  meeting_place text,
  formed_on date NOT NULL DEFAULT CURRENT_DATE,
  status text NOT NULL DEFAULT 'forming'
    CHECK (status IN ('forming','active','dormant','closed')),
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX mf_groups_number_unique
  ON public.mf_groups (business_id, lower(group_number));
CREATE INDEX mf_groups_branch_idx ON public.mf_groups (business_id, branch_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.mf_groups TO authenticated;
GRANT ALL ON public.mf_groups TO service_role;

ALTER TABLE public.mf_groups ENABLE ROW LEVEL SECURITY;

CREATE POLICY "mf_groups_read" ON public.mf_groups
  FOR SELECT TO authenticated
  USING (public.user_has_business_access(auth.uid(), business_id));

CREATE POLICY "mf_groups_insert" ON public.mf_groups
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

CREATE POLICY "mf_groups_update" ON public.mf_groups
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

CREATE POLICY "mf_groups_delete" ON public.mf_groups
  FOR DELETE TO authenticated
  USING (
    public.user_has_business_access(auth.uid(), business_id)
    AND (public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'admin'))
  );

CREATE TRIGGER mf_groups_touch
  BEFORE UPDATE ON public.mf_groups
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE public.mf_group_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  group_id uuid NOT NULL REFERENCES public.mf_groups(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES public.mf_clients(id) ON DELETE CASCADE,
  role_in_group text NOT NULL DEFAULT 'member'
    CHECK (role_in_group IN ('member','leader','secretary','treasurer')),
  joined_on date NOT NULL DEFAULT CURRENT_DATE,
  exited_on date,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX mf_group_members_active_unique
  ON public.mf_group_members (group_id, client_id) WHERE is_active;
CREATE UNIQUE INDEX mf_group_members_single_leader
  ON public.mf_group_members (group_id) WHERE is_active AND role_in_group = 'leader';
CREATE INDEX mf_group_members_client_idx ON public.mf_group_members (client_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.mf_group_members TO authenticated;
GRANT ALL ON public.mf_group_members TO service_role;

ALTER TABLE public.mf_group_members ENABLE ROW LEVEL SECURITY;

CREATE POLICY "mf_group_members_read" ON public.mf_group_members
  FOR SELECT TO authenticated
  USING (public.user_has_business_access(auth.uid(), business_id));

CREATE POLICY "mf_group_members_insert" ON public.mf_group_members
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

CREATE POLICY "mf_group_members_update" ON public.mf_group_members
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

CREATE POLICY "mf_group_members_delete" ON public.mf_group_members
  FOR DELETE TO authenticated
  USING (
    public.user_has_business_access(auth.uid(), business_id)
    AND (public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'admin'))
  );

CREATE TRIGGER mf_group_members_touch
  BEFORE UPDATE ON public.mf_group_members
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();