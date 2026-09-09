CREATE TABLE public.branch_operational_days (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES public.branches(id) ON DELETE CASCADE,
  business_date date NOT NULL,
  status text NOT NULL DEFAULT 'open',
  opening_cash numeric(18,2) NOT NULL DEFAULT 0,
  expected_cash numeric(18,2),
  counted_cash numeric(18,2),
  variance numeric(18,2),
  variance_reason text,
  variance_journal_entry_id uuid,
  notes text,
  opened_by uuid,
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_by uuid,
  closed_at timestamptz,
  reopened_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT branch_operational_days_status_chk CHECK (status IN ('open','closed')),
  CONSTRAINT branch_operational_days_unique_day UNIQUE (branch_id, business_date)
);

CREATE INDEX idx_branch_operational_days_branch_date ON public.branch_operational_days (branch_id, business_date DESC);
CREATE INDEX idx_branch_operational_days_open ON public.branch_operational_days (branch_id) WHERE status = 'open';

GRANT SELECT ON public.branch_operational_days TO authenticated;
GRANT ALL ON public.branch_operational_days TO service_role;

ALTER TABLE public.branch_operational_days ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Business members can view branch days"
ON public.branch_operational_days FOR SELECT TO authenticated
USING (public.user_has_business_access(auth.uid(), business_id));

CREATE TRIGGER trg_branch_operational_days_updated_at
BEFORE UPDATE ON public.branch_operational_days
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();