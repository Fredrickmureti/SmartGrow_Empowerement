CREATE TABLE public.document_number_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  sequence_key text NOT NULL CHECK (sequence_key IN ('loan','loan_application','client','receipt','disbursement')),
  prefix text NOT NULL CHECK (prefix ~ '^[A-Z][A-Z0-9]{1,7}$'),
  padding smallint NOT NULL DEFAULT 5 CHECK (padding BETWEEN 3 AND 9),
  period_reset text NOT NULL DEFAULT 'never' CHECK (period_reset IN ('never','yearly','monthly')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX document_number_rules_scope_key
  ON public.document_number_rules (business_id, COALESCE(branch_id, '00000000-0000-0000-0000-000000000000'::uuid), sequence_key);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.document_number_rules TO authenticated;
GRANT ALL ON public.document_number_rules TO service_role;
ALTER TABLE public.document_number_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Company staff read numbering rules"
  ON public.document_number_rules FOR SELECT TO authenticated
  USING (public.user_has_business_access(auth.uid(), business_id));

CREATE POLICY "Company staff manage numbering rules"
  ON public.document_number_rules FOR ALL TO authenticated
  USING (public.user_has_business_access(auth.uid(), business_id))
  WITH CHECK (public.user_has_business_access(auth.uid(), business_id));

CREATE TRIGGER document_number_rules_touch
  BEFORE UPDATE ON public.document_number_rules
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE public.document_number_counters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  sequence_key text NOT NULL,
  period_key text NOT NULL DEFAULT '',
  current_value bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX document_number_counters_scope_key
  ON public.document_number_counters (business_id, COALESCE(branch_id, '00000000-0000-0000-0000-000000000000'::uuid), sequence_key, period_key);

GRANT SELECT ON public.document_number_counters TO authenticated;
GRANT ALL ON public.document_number_counters TO service_role;
ALTER TABLE public.document_number_counters ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Company staff read numbering counters"
  ON public.document_number_counters FOR SELECT TO authenticated
  USING (public.user_has_business_access(auth.uid(), business_id));