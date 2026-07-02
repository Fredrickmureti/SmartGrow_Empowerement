
-- =========================================================================
-- S1 + S3 — Payroll liability ledger foundation
-- =========================================================================

-- 1. payroll_liabilities -----------------------------------------------------
CREATE TABLE IF NOT EXISTS public.payroll_liabilities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  branch_id UUID REFERENCES public.branches(id),

  -- statutory authority + classification
  rule_code TEXT NOT NULL,                  -- e.g. 'paye', 'nssf', 'shif', 'housing_levy'
  authority_name TEXT NOT NULL,             -- e.g. 'KRA', 'NSSF', 'SHA'
  label TEXT NOT NULL,                      -- human label
  country_code TEXT,                        -- pack country if any

  -- period this liability covers
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  due_date DATE,

  -- amounts
  original_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  paid_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  outstanding_amount NUMERIC(18,2) NOT NULL DEFAULT 0,

  -- accounting
  liability_account_id UUID REFERENCES public.accounts(id),
  journal_entry_id UUID REFERENCES public.journal_entries(id),

  -- status: 'open' | 'partial' | 'paid' | 'legacy_paid' | 'void'
  status TEXT NOT NULL DEFAULT 'open',

  -- legacy-link for backfill from payroll_remittances
  legacy_remittance_id UUID,
  is_legacy_paid BOOLEAN NOT NULL DEFAULT false,

  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID,

  CONSTRAINT payroll_liabilities_amounts_chk
    CHECK (original_amount >= 0 AND paid_amount >= 0 AND outstanding_amount >= 0
           AND paid_amount <= original_amount),
  CONSTRAINT payroll_liabilities_status_chk
    CHECK (status IN ('open','partial','paid','legacy_paid','void'))
);

CREATE INDEX IF NOT EXISTS idx_payroll_liabilities_business
  ON public.payroll_liabilities(business_id);
CREATE INDEX IF NOT EXISTS idx_payroll_liabilities_branch
  ON public.payroll_liabilities(branch_id);
CREATE INDEX IF NOT EXISTS idx_payroll_liabilities_status
  ON public.payroll_liabilities(business_id, status);
CREATE INDEX IF NOT EXISTS idx_payroll_liabilities_due
  ON public.payroll_liabilities(business_id, due_date);
CREATE INDEX IF NOT EXISTS idx_payroll_liabilities_period
  ON public.payroll_liabilities(business_id, period_start, period_end);
CREATE INDEX IF NOT EXISTS idx_payroll_liabilities_rule
  ON public.payroll_liabilities(business_id, rule_code);

-- 2. payroll_liability_sources ----------------------------------------------
CREATE TABLE IF NOT EXISTS public.payroll_liability_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  liability_id UUID NOT NULL REFERENCES public.payroll_liabilities(id) ON DELETE CASCADE,
  payroll_run_id UUID REFERENCES public.payroll_runs(id) ON DELETE CASCADE,
  payslip_id UUID REFERENCES public.payslips(id) ON DELETE CASCADE,
  payslip_line_id UUID REFERENCES public.payslip_lines(id) ON DELETE CASCADE,
  amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payroll_liability_sources_liability
  ON public.payroll_liability_sources(liability_id);
CREATE INDEX IF NOT EXISTS idx_payroll_liability_sources_run
  ON public.payroll_liability_sources(payroll_run_id);

-- 3. payroll_remittance_payments --------------------------------------------
CREATE TABLE IF NOT EXISTS public.payroll_remittance_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  branch_id UUID REFERENCES public.branches(id),

  authority_name TEXT NOT NULL,
  payment_date DATE NOT NULL,
  payment_method TEXT,
  bank_account_id UUID REFERENCES public.accounts(id),
  reference_number TEXT,
  proof_url TEXT,
  notes TEXT,

  total_amount NUMERIC(18,2) NOT NULL CHECK (total_amount > 0),
  journal_entry_id UUID REFERENCES public.journal_entries(id),

  status TEXT NOT NULL DEFAULT 'posted',  -- 'posted' | 'reversed'
  reversed_at TIMESTAMPTZ,
  reversed_by UUID,
  reversal_reason TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID,
  CONSTRAINT payroll_remittance_payments_status_chk
    CHECK (status IN ('posted','reversed'))
);
CREATE INDEX IF NOT EXISTS idx_payroll_remittance_payments_business
  ON public.payroll_remittance_payments(business_id);
CREATE INDEX IF NOT EXISTS idx_payroll_remittance_payments_branch
  ON public.payroll_remittance_payments(branch_id);
CREATE INDEX IF NOT EXISTS idx_payroll_remittance_payments_date
  ON public.payroll_remittance_payments(business_id, payment_date);

-- 4. payroll_remittance_payment_allocations ---------------------------------
CREATE TABLE IF NOT EXISTS public.payroll_remittance_payment_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id UUID NOT NULL REFERENCES public.payroll_remittance_payments(id) ON DELETE CASCADE,
  liability_id UUID NOT NULL REFERENCES public.payroll_liabilities(id) ON DELETE CASCADE,
  amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (payment_id, liability_id)
);
CREATE INDEX IF NOT EXISTS idx_payroll_remit_alloc_payment
  ON public.payroll_remittance_payment_allocations(payment_id);
CREATE INDEX IF NOT EXISTS idx_payroll_remit_alloc_liability
  ON public.payroll_remittance_payment_allocations(liability_id);

-- 5. localization_pack_remittance_schedules ---------------------------------
CREATE TABLE IF NOT EXISTS public.localization_pack_remittance_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pack_id UUID NOT NULL REFERENCES public.localization_packs(id) ON DELETE CASCADE,
  rule_code TEXT NOT NULL,
  authority_name TEXT NOT NULL,
  frequency TEXT NOT NULL DEFAULT 'monthly',  -- monthly|quarterly|annual
  due_day SMALLINT,                            -- day-of-period for monthly/quarterly
  due_month SMALLINT,                          -- month for annual
  liability_account_setting_key TEXT,          -- maps to default_account_settings.setting_key
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (pack_id, rule_code),
  CONSTRAINT localization_pack_remittance_freq_chk
    CHECK (frequency IN ('monthly','quarterly','annual'))
);

-- =========================================================================
-- RLS — mirror payroll_remittances policies (business-scoped + payroll perm)
-- =========================================================================
ALTER TABLE public.payroll_liabilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_liability_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_remittance_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_remittance_payment_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.localization_pack_remittance_schedules ENABLE ROW LEVEL SECURITY;

-- payroll_liabilities
CREATE POLICY payroll_liabilities_select ON public.payroll_liabilities FOR SELECT
USING (business_id IS NOT NULL
       AND user_can_access_business(auth.uid(), business_id)
       AND user_has_module_permission(auth.uid(), organization_id, business_id, 'payroll', 'read'));
CREATE POLICY payroll_liabilities_insert ON public.payroll_liabilities FOR INSERT
WITH CHECK (business_id IS NOT NULL
            AND user_can_access_business(auth.uid(), business_id)
            AND user_has_module_permission(auth.uid(), organization_id, business_id, 'payroll', 'create'));
CREATE POLICY payroll_liabilities_update ON public.payroll_liabilities FOR UPDATE
USING (business_id IS NOT NULL
       AND user_can_access_business(auth.uid(), business_id)
       AND user_has_module_permission(auth.uid(), organization_id, business_id, 'payroll', 'write'))
WITH CHECK (business_id IS NOT NULL
            AND user_can_access_business(auth.uid(), business_id)
            AND user_has_module_permission(auth.uid(), organization_id, business_id, 'payroll', 'write'));

-- payroll_liability_sources — inherit through liability
CREATE POLICY payroll_liability_sources_select ON public.payroll_liability_sources FOR SELECT
USING (EXISTS (SELECT 1 FROM public.payroll_liabilities l
               WHERE l.id = payroll_liability_sources.liability_id
                 AND user_can_access_business(auth.uid(), l.business_id)
                 AND user_has_module_permission(auth.uid(), l.organization_id, l.business_id, 'payroll', 'read')));
CREATE POLICY payroll_liability_sources_insert ON public.payroll_liability_sources FOR INSERT
WITH CHECK (EXISTS (SELECT 1 FROM public.payroll_liabilities l
                    WHERE l.id = payroll_liability_sources.liability_id
                      AND user_can_access_business(auth.uid(), l.business_id)
                      AND user_has_module_permission(auth.uid(), l.organization_id, l.business_id, 'payroll', 'create')));

-- payroll_remittance_payments
CREATE POLICY payroll_remittance_payments_select ON public.payroll_remittance_payments FOR SELECT
USING (business_id IS NOT NULL
       AND user_can_access_business(auth.uid(), business_id)
       AND user_has_module_permission(auth.uid(), organization_id, business_id, 'payroll', 'read'));
CREATE POLICY payroll_remittance_payments_insert ON public.payroll_remittance_payments FOR INSERT
WITH CHECK (business_id IS NOT NULL
            AND user_can_access_business(auth.uid(), business_id)
            AND user_has_module_permission(auth.uid(), organization_id, business_id, 'payroll', 'create'));
CREATE POLICY payroll_remittance_payments_update ON public.payroll_remittance_payments FOR UPDATE
USING (business_id IS NOT NULL
       AND user_can_access_business(auth.uid(), business_id)
       AND user_has_module_permission(auth.uid(), organization_id, business_id, 'payroll', 'write'))
WITH CHECK (business_id IS NOT NULL
            AND user_can_access_business(auth.uid(), business_id)
            AND user_has_module_permission(auth.uid(), organization_id, business_id, 'payroll', 'write'));

-- allocations — inherit via payment
CREATE POLICY payroll_remit_alloc_select ON public.payroll_remittance_payment_allocations FOR SELECT
USING (EXISTS (SELECT 1 FROM public.payroll_remittance_payments p
               WHERE p.id = payroll_remittance_payment_allocations.payment_id
                 AND user_can_access_business(auth.uid(), p.business_id)
                 AND user_has_module_permission(auth.uid(), p.organization_id, p.business_id, 'payroll', 'read')));
CREATE POLICY payroll_remit_alloc_insert ON public.payroll_remittance_payment_allocations FOR INSERT
WITH CHECK (EXISTS (SELECT 1 FROM public.payroll_remittance_payments p
                    WHERE p.id = payroll_remittance_payment_allocations.payment_id
                      AND user_can_access_business(auth.uid(), p.business_id)
                      AND user_has_module_permission(auth.uid(), p.organization_id, p.business_id, 'payroll', 'create')));

-- localization_pack_remittance_schedules — readable by any authenticated user (template data)
CREATE POLICY localization_pack_remit_sched_select ON public.localization_pack_remittance_schedules FOR SELECT
USING (auth.uid() IS NOT NULL);

-- =========================================================================
-- Triggers
-- =========================================================================

-- a) updated_at maintenance
CREATE OR REPLACE FUNCTION public._payroll_liab_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

CREATE TRIGGER trg_payroll_liabilities_updated_at
  BEFORE UPDATE ON public.payroll_liabilities
  FOR EACH ROW EXECUTE FUNCTION public._payroll_liab_set_updated_at();

CREATE TRIGGER trg_payroll_remit_payments_updated_at
  BEFORE UPDATE ON public.payroll_remittance_payments
  FOR EACH ROW EXECUTE FUNCTION public._payroll_liab_set_updated_at();

-- b) branch ↔ business match (reuse existing function)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'enforce_branch_business_match') THEN
    EXECUTE 'CREATE TRIGGER trg_pl_branch_business_match
             BEFORE INSERT OR UPDATE ON public.payroll_liabilities
             FOR EACH ROW EXECUTE FUNCTION public.enforce_branch_business_match()';
    EXECUTE 'CREATE TRIGGER trg_prp_branch_business_match
             BEFORE INSERT OR UPDATE ON public.payroll_remittance_payments
             FOR EACH ROW EXECUTE FUNCTION public.enforce_branch_business_match()';
  END IF;
END $$;

-- c) keep paid_amount + outstanding_amount + status in sync from allocations
CREATE OR REPLACE FUNCTION public.recompute_payroll_liability_totals(_liability_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_paid NUMERIC(18,2);
  v_orig NUMERIC(18,2);
  v_status TEXT;
  v_legacy BOOLEAN;
BEGIN
  SELECT original_amount, is_legacy_paid INTO v_orig, v_legacy
    FROM public.payroll_liabilities WHERE id = _liability_id;
  IF v_orig IS NULL THEN RETURN; END IF;

  SELECT COALESCE(SUM(a.amount),0) INTO v_paid
    FROM public.payroll_remittance_payment_allocations a
    JOIN public.payroll_remittance_payments p ON p.id = a.payment_id
    WHERE a.liability_id = _liability_id
      AND p.status = 'posted';

  IF v_legacy AND v_paid = 0 THEN
    v_status := 'legacy_paid';
  ELSIF v_paid = 0 THEN
    v_status := 'open';
  ELSIF v_paid >= v_orig THEN
    v_status := 'paid';
  ELSE
    v_status := 'partial';
  END IF;

  UPDATE public.payroll_liabilities
     SET paid_amount = v_paid,
         outstanding_amount = GREATEST(v_orig - v_paid, 0),
         status = v_status,
         updated_at = now()
   WHERE id = _liability_id;
END $$;

CREATE OR REPLACE FUNCTION public.tg_recompute_liability_on_alloc()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.recompute_payroll_liability_totals(COALESCE(NEW.liability_id, OLD.liability_id));
  RETURN COALESCE(NEW, OLD);
END $$;

CREATE TRIGGER trg_recompute_liab_on_alloc
  AFTER INSERT OR UPDATE OR DELETE
  ON public.payroll_remittance_payment_allocations
  FOR EACH ROW EXECUTE FUNCTION public.tg_recompute_liability_on_alloc();

-- d) guard: paid_amount must be set via allocations only (block direct writes that
--    don't match the allocation sum). Allows the recompute fn (SECURITY DEFINER) to write.
CREATE OR REPLACE FUNCTION public.enforce_liability_paid_via_allocations()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_alloc NUMERIC(18,2);
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.paid_amount IS DISTINCT FROM OLD.paid_amount THEN
    SELECT COALESCE(SUM(a.amount),0) INTO v_alloc
      FROM public.payroll_remittance_payment_allocations a
      JOIN public.payroll_remittance_payments p ON p.id = a.payment_id
      WHERE a.liability_id = NEW.id AND p.status = 'posted';
    IF NEW.paid_amount IS DISTINCT FROM v_alloc AND NOT NEW.is_legacy_paid THEN
      RAISE EXCEPTION 'payroll_liabilities.paid_amount can only be changed via posted remittance payment allocations (got %, allocated %)', NEW.paid_amount, v_alloc;
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_enforce_liab_paid_via_alloc
  BEFORE UPDATE ON public.payroll_liabilities
  FOR EACH ROW EXECUTE FUNCTION public.enforce_liability_paid_via_allocations();

-- e) initial outstanding = original on insert
CREATE OR REPLACE FUNCTION public.tg_init_liability_outstanding()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.outstanding_amount IS NULL OR NEW.outstanding_amount = 0 THEN
    NEW.outstanding_amount := GREATEST(NEW.original_amount - COALESCE(NEW.paid_amount,0), 0);
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_init_liability_outstanding
  BEFORE INSERT ON public.payroll_liabilities
  FOR EACH ROW EXECUTE FUNCTION public.tg_init_liability_outstanding();

-- =========================================================================
-- Backfill from existing payroll_remittances
-- =========================================================================
INSERT INTO public.payroll_liabilities
  (organization_id, business_id, branch_id, rule_code, authority_name, label,
   period_start, period_end, due_date, original_amount, paid_amount,
   outstanding_amount, status, legacy_remittance_id, is_legacy_paid,
   notes, created_at)
SELECT
  r.organization_id,
  r.business_id,
  pr.branch_id,
  r.remittance_type,
  COALESCE(NULLIF(r.remittance_label, ''), upper(r.remittance_type)),
  COALESCE(NULLIF(r.remittance_label, ''), upper(r.remittance_type)),
  pr.pay_period_start,
  pr.pay_period_end,
  r.due_date,
  COALESCE(r.amount,0) + COALESCE(r.employer_amount,0),
  CASE WHEN r.status = 'paid' THEN COALESCE(r.amount,0) + COALESCE(r.employer_amount,0) ELSE 0 END,
  CASE WHEN r.status = 'paid' THEN 0 ELSE COALESCE(r.amount,0) + COALESCE(r.employer_amount,0) END,
  CASE WHEN r.status = 'paid' THEN 'legacy_paid' ELSE 'open' END,
  r.id,
  CASE WHEN r.status = 'paid' THEN true ELSE false END,
  r.notes,
  r.created_at
FROM public.payroll_remittances r
JOIN public.payroll_runs pr ON pr.id = r.payroll_run_id
WHERE NOT EXISTS (
  SELECT 1 FROM public.payroll_liabilities l WHERE l.legacy_remittance_id = r.id
);

-- Backfill sources for each backfilled liability
INSERT INTO public.payroll_liability_sources (liability_id, payroll_run_id, amount)
SELECT l.id, r.payroll_run_id, l.original_amount
FROM public.payroll_liabilities l
JOIN public.payroll_remittances r ON r.id = l.legacy_remittance_id
WHERE NOT EXISTS (
  SELECT 1 FROM public.payroll_liability_sources s
  WHERE s.liability_id = l.id AND s.payroll_run_id = r.payroll_run_id
);

COMMENT ON TABLE public.payroll_liabilities IS
  'First-class statutory liability ledger. One row per (business, branch, rule_code, period). Replaces the binary-status payroll_remittances row as the source of truth for "what is owed".';
COMMENT ON COLUMN public.payroll_liabilities.is_legacy_paid IS
  'Backfilled from payroll_remittances.status=paid where no journal entry exists. UI surfaces this as a warning — historical paid remittances had no GL impact.';
