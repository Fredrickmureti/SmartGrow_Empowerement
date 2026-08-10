DO $$ BEGIN
  CREATE TYPE public.dunning_action_type AS ENUM ('reminder','statement','call','escalate','legal');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.dunning_levels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid,
  name text NOT NULL,
  sequence integer NOT NULL,
  min_days_overdue integer NOT NULL DEFAULT 0,
  action_type public.dunning_action_type NOT NULL DEFAULT 'reminder',
  template_id uuid,
  active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS dunning_levels_one_sequence_per_scope
  ON public.dunning_levels (organization_id, COALESCE(business_id, '00000000-0000-0000-0000-000000000000'::uuid), sequence)
  WHERE active;

CREATE INDEX IF NOT EXISTS dunning_levels_scope_idx
  ON public.dunning_levels (organization_id, business_id, min_days_overdue);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.dunning_levels TO authenticated;
GRANT ALL ON public.dunning_levels TO service_role;

ALTER TABLE public.dunning_levels ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Org members can view dunning levels" ON public.dunning_levels;
CREATE POLICY "Org members can view dunning levels"
  ON public.dunning_levels FOR SELECT TO authenticated
  USING (public.is_org_member(auth.uid(), organization_id));

DROP POLICY IF EXISTS "Org members can manage dunning levels" ON public.dunning_levels;
CREATE POLICY "Org members can manage dunning levels"
  ON public.dunning_levels FOR ALL TO authenticated
  USING (public.is_org_member(auth.uid(), organization_id))
  WITH CHECK (public.is_org_member(auth.uid(), organization_id));

DROP TRIGGER IF EXISTS update_dunning_levels_updated_at ON public.dunning_levels;
CREATE TRIGGER update_dunning_levels_updated_at
  BEFORE UPDATE ON public.dunning_levels
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Default escalation ladder for every existing organization (org-wide scope).
INSERT INTO public.dunning_levels (organization_id, business_id, name, sequence, min_days_overdue, action_type)
SELECT o.id, NULL, v.name, v.seq, v.mdo, v.act::public.dunning_action_type
FROM (SELECT DISTINCT organization_id AS id FROM public.businesses WHERE organization_id IS NOT NULL) o
CROSS JOIN (VALUES
  ('Friendly reminder', 1, 1, 'reminder'),
  ('Statement of account', 2, 31, 'statement'),
  ('Collection call', 3, 61, 'call'),
  ('Escalate to management', 4, 91, 'escalate')
) AS v(name, seq, mdo, act)
WHERE NOT EXISTS (
  SELECT 1 FROM public.dunning_levels d
  WHERE d.organization_id = o.id AND d.business_id IS NULL AND d.sequence = v.seq
);

-- Next action per customer, derived from the canonical AR net position.
CREATE OR REPLACE VIEW public.dunning_assignment
WITH (security_invoker = true) AS
SELECT
  np.organization_id,
  np.business_id,
  np.branch_id,
  np.contact_id,
  np.contact_name,
  np.net_amount,
  np.max_days_overdue,
  lvl.id            AS dunning_level_id,
  lvl.name          AS dunning_level_name,
  lvl.sequence      AS dunning_sequence,
  lvl.action_type   AS next_action,
  lvl.template_id   AS template_id
FROM public.finance_ar_net_position np
LEFT JOIN LATERAL (
  SELECT d.*
  FROM public.dunning_levels d
  WHERE d.organization_id = np.organization_id
    AND d.active
    AND (d.business_id IS NULL OR d.business_id = np.business_id)
    AND np.max_days_overdue >= d.min_days_overdue
  ORDER BY (d.business_id IS NOT NULL) DESC, d.min_days_overdue DESC, d.sequence DESC
  LIMIT 1
) lvl ON true
WHERE np.net_amount > 0.01;

GRANT SELECT ON public.dunning_assignment TO authenticated;
GRANT SELECT ON public.dunning_assignment TO service_role;