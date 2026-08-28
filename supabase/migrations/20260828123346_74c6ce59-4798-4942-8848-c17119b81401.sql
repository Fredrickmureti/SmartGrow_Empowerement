CREATE TABLE public.consolidation_run_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.consolidation_runs(id) ON DELETE CASCADE,
  business_id uuid NOT NULL,
  business_name text NOT NULL,
  base_currency text NOT NULL,
  is_parent boolean NOT NULL DEFAULT false,
  method public.consolidation_method NOT NULL,
  ownership_percent numeric NOT NULL DEFAULT 100,
  requires_translation boolean NOT NULL DEFAULT false,
  effective_from date,
  effective_to date,
  UNIQUE (run_id, business_id)
);

CREATE TABLE public.consolidation_run_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.consolidation_runs(id) ON DELETE CASCADE,
  business_id uuid NOT NULL,
  from_currency text NOT NULL,
  to_currency text NOT NULL,
  closing_rate numeric,
  opening_rate numeric,
  average_rate numeric,
  prior_average_rate numeric,
  historical_rate numeric,
  historical_date date,
  UNIQUE (run_id, business_id, from_currency, to_currency)
);

CREATE TABLE public.consolidation_run_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.consolidation_runs(id) ON DELETE CASCADE,
  statement text NOT NULL,
  section text NOT NULL,
  section_order integer NOT NULL DEFAULT 0,
  group_account_id uuid,
  account_code text,
  account_name text NOT NULL,
  account_type public.account_type,
  is_residual boolean NOT NULL DEFAULT false,
  is_derived boolean NOT NULL DEFAULT false,
  presentation_currency text NOT NULL,
  aggregated_amount numeric NOT NULL DEFAULT 0,
  elimination_amount numeric NOT NULL DEFAULT 0,
  consolidated_amount numeric NOT NULL DEFAULT 0,
  member_contributions jsonb NOT NULL DEFAULT '[]'::jsonb,
  line_order integer NOT NULL DEFAULT 0
);

CREATE INDEX consolidation_run_lines_run_idx ON public.consolidation_run_lines (run_id, statement, section_order, line_order);
CREATE INDEX consolidation_run_rates_run_idx ON public.consolidation_run_rates (run_id);
CREATE INDEX consolidation_run_members_run_idx ON public.consolidation_run_members (run_id);

COMMENT ON TABLE public.consolidation_run_lines IS 'Brick 8: statement lines frozen by a consolidation run, with the member contributions behind each line.';
COMMENT ON TABLE public.consolidation_run_rates IS 'Brick 8: the translation rate basis a consolidation run actually used, per member.';
COMMENT ON TABLE public.consolidation_run_members IS 'Brick 8: the consolidation scope as resolved at run time.';

REVOKE ALL ON public.consolidation_run_lines FROM anon;
REVOKE ALL ON public.consolidation_run_rates FROM anon;
REVOKE ALL ON public.consolidation_run_members FROM anon;

GRANT SELECT, INSERT, DELETE ON public.consolidation_run_lines TO authenticated;
GRANT SELECT, INSERT, DELETE ON public.consolidation_run_rates TO authenticated;
GRANT SELECT, INSERT, DELETE ON public.consolidation_run_members TO authenticated;

GRANT ALL ON public.consolidation_run_lines TO service_role;
GRANT ALL ON public.consolidation_run_rates TO service_role;
GRANT ALL ON public.consolidation_run_members TO service_role;

ALTER TABLE public.consolidation_run_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.consolidation_run_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.consolidation_run_members ENABLE ROW LEVEL SECURITY;

CREATE POLICY consolidation_run_lines_select ON public.consolidation_run_lines
FOR SELECT USING (EXISTS (SELECT 1 FROM public.consolidation_runs r WHERE r.id = consolidation_run_lines.run_id));
CREATE POLICY consolidation_run_lines_write ON public.consolidation_run_lines
FOR INSERT WITH CHECK (EXISTS (
  SELECT 1 FROM public.consolidation_runs r
   WHERE r.id = consolidation_run_lines.run_id
     AND r.state = 'draft'
     AND public.has_org_role(auth.uid(), r.organization_id, 'owner'::public.app_role)
      OR (r.id = consolidation_run_lines.run_id AND r.state = 'draft'
          AND (public.has_org_role(auth.uid(), r.organization_id, 'admin'::public.app_role)
            OR public.has_org_role(auth.uid(), r.organization_id, 'super_admin'::public.app_role)))
));
CREATE POLICY consolidation_run_lines_delete ON public.consolidation_run_lines
FOR DELETE USING (EXISTS (
  SELECT 1 FROM public.consolidation_runs r
   WHERE r.id = consolidation_run_lines.run_id AND r.state = 'draft'
     AND (public.has_org_role(auth.uid(), r.organization_id, 'owner'::public.app_role)
       OR public.has_org_role(auth.uid(), r.organization_id, 'admin'::public.app_role)
       OR public.has_org_role(auth.uid(), r.organization_id, 'super_admin'::public.app_role))
));

CREATE POLICY consolidation_run_rates_select ON public.consolidation_run_rates
FOR SELECT USING (EXISTS (SELECT 1 FROM public.consolidation_runs r WHERE r.id = consolidation_run_rates.run_id));
CREATE POLICY consolidation_run_rates_write ON public.consolidation_run_rates
FOR INSERT WITH CHECK (EXISTS (
  SELECT 1 FROM public.consolidation_runs r
   WHERE r.id = consolidation_run_rates.run_id AND r.state = 'draft'
     AND (public.has_org_role(auth.uid(), r.organization_id, 'owner'::public.app_role)
       OR public.has_org_role(auth.uid(), r.organization_id, 'admin'::public.app_role)
       OR public.has_org_role(auth.uid(), r.organization_id, 'super_admin'::public.app_role))
));
CREATE POLICY consolidation_run_rates_delete ON public.consolidation_run_rates
FOR DELETE USING (EXISTS (
  SELECT 1 FROM public.consolidation_runs r
   WHERE r.id = consolidation_run_rates.run_id AND r.state = 'draft'
     AND (public.has_org_role(auth.uid(), r.organization_id, 'owner'::public.app_role)
       OR public.has_org_role(auth.uid(), r.organization_id, 'admin'::public.app_role)
       OR public.has_org_role(auth.uid(), r.organization_id, 'super_admin'::public.app_role))
));

CREATE POLICY consolidation_run_members_select ON public.consolidation_run_members
FOR SELECT USING (EXISTS (SELECT 1 FROM public.consolidation_runs r WHERE r.id = consolidation_run_members.run_id));
CREATE POLICY consolidation_run_members_write ON public.consolidation_run_members
FOR INSERT WITH CHECK (EXISTS (
  SELECT 1 FROM public.consolidation_runs r
   WHERE r.id = consolidation_run_members.run_id AND r.state = 'draft'
     AND (public.has_org_role(auth.uid(), r.organization_id, 'owner'::public.app_role)
       OR public.has_org_role(auth.uid(), r.organization_id, 'admin'::public.app_role)
       OR public.has_org_role(auth.uid(), r.organization_id, 'super_admin'::public.app_role))
));
CREATE POLICY consolidation_run_members_delete ON public.consolidation_run_members
FOR DELETE USING (EXISTS (
  SELECT 1 FROM public.consolidation_runs r
   WHERE r.id = consolidation_run_members.run_id AND r.state = 'draft'
     AND (public.has_org_role(auth.uid(), r.organization_id, 'owner'::public.app_role)
       OR public.has_org_role(auth.uid(), r.organization_id, 'admin'::public.app_role)
       OR public.has_org_role(auth.uid(), r.organization_id, 'super_admin'::public.app_role))
));