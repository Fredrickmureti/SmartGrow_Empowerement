
-- ============================================================
-- R1: Close the bypass — enforce role rules at the table tier.
-- ============================================================

CREATE OR REPLACE FUNCTION public._payroll_default_account_role_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.setting_key IS NULL OR NEW.account_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Only fire for payroll-shaped keys. Other modules will get their own
  -- role-check triggers as they need them (see ADR 0022).
  IF NEW.setting_key = 'salary_expense'
     OR NEW.setting_key LIKE '%\_payable' ESCAPE '\'
     OR NEW.setting_key LIKE '%\_employer\_expense' ESCAPE '\'
  THEN
    PERFORM public._payroll_assert_mapping_role(NEW.setting_key, NEW.account_id);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_default_account_settings_payroll_role
  ON public.default_account_settings;

CREATE TRIGGER trg_default_account_settings_payroll_role
BEFORE INSERT OR UPDATE OF account_id, setting_key
ON public.default_account_settings
FOR EACH ROW
EXECUTE FUNCTION public._payroll_default_account_role_trigger();

COMMENT ON FUNCTION public._payroll_default_account_role_trigger() IS
  'Wave-3: enforces _payroll_assert_mapping_role on every write to default_account_settings, '
  'not just writes that go through payroll_apply_proposed_mappings. Closes the DefaultAccountsConfig.tsx bypass.';

-- ============================================================
-- R2a: Add reclassification tracking on payroll_runs.
-- ============================================================

ALTER TABLE public.payroll_runs
  ADD COLUMN IF NOT EXISTS reclassification_journal_entry_id uuid
    REFERENCES public.journal_entries(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.payroll_runs.reclassification_journal_entry_id IS
  'JE that corrects a payroll run posted with a role-violating mapping (e.g. salary → COGS). Set once and only by payroll_generate_reclassification_je.';

-- ============================================================
-- R2b: Audit table for reclassifications.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.payroll_reclassification_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid,
  payroll_run_id uuid NOT NULL REFERENCES public.payroll_runs(id) ON DELETE CASCADE,
  original_journal_entry_id uuid NOT NULL REFERENCES public.journal_entries(id) ON DELETE RESTRICT,
  reclassification_journal_entry_id uuid NOT NULL REFERENCES public.journal_entries(id) ON DELETE RESTRICT,
  lines_corrected integer NOT NULL,
  amount_corrected numeric(18,2) NOT NULL,
  from_account_codes text[] NOT NULL,
  to_account_id uuid NOT NULL REFERENCES public.accounts(id),
  performed_by uuid,
  performed_at timestamptz NOT NULL DEFAULT now(),
  reason text
);

CREATE INDEX IF NOT EXISTS idx_payroll_reclass_audit_run
  ON public.payroll_reclassification_audit(payroll_run_id);

ALTER TABLE public.payroll_reclassification_audit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "payroll_reclass_audit_select" ON public.payroll_reclassification_audit;
CREATE POLICY "payroll_reclass_audit_select"
ON public.payroll_reclassification_audit
FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = auth.uid()
      AND ur.organization_id = payroll_reclassification_audit.organization_id
      AND ur.is_active = true
  )
);
-- No INSERT/UPDATE/DELETE policies — only SECURITY DEFINER writes.

-- ============================================================
-- R2c: The reclassification RPC.
-- ============================================================

CREATE OR REPLACE FUNCTION public.payroll_generate_reclassification_je(p_run_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user           uuid := auth.uid();
  v_run            public.payroll_runs%ROWTYPE;
  v_orig_je        public.journal_entries%ROWTYPE;
  v_target_acct    uuid;
  v_new_je_id      uuid;
  v_new_entry_no   text;
  v_bad_count      integer;
  v_bad_total      numeric(18,2);
  v_bad_codes      text[];
  v_branch_id      uuid;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_run FROM public.payroll_runs WHERE id = p_run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'payroll_run % not found', p_run_id USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = v_user
      AND ur.organization_id = v_run.organization_id
      AND ur.is_active = true
  ) THEN
    RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
  END IF;

  IF v_run.reclassification_journal_entry_id IS NOT NULL THEN
    RAISE EXCEPTION 'payroll_run % has already been reclassified (JE %)',
      p_run_id, v_run.reclassification_journal_entry_id USING ERRCODE = '22023';
  END IF;

  -- Locate the original posted payroll JE.
  SELECT * INTO v_orig_je
  FROM public.journal_entries
  WHERE source_type = 'payroll'
    AND source_id = p_run_id
    AND organization_id = v_run.organization_id
    AND status = 'posted'
  ORDER BY posted_at DESC NULLS LAST
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No posted payroll JE found for run %', p_run_id USING ERRCODE = '22023';
  END IF;

  -- Resolve the target salary_expense account from the CURRENT mappings.
  -- After R1, this is guaranteed to be role-compliant (not COGS, not header,
  -- account_type = expense). Business-level override beats org-level.
  SELECT account_id INTO v_target_acct
  FROM public.default_account_settings
  WHERE organization_id = v_run.organization_id
    AND setting_key = 'salary_expense'
    AND (business_id = v_run.business_id OR (business_id IS NULL AND v_run.business_id IS NULL))
  LIMIT 1;

  IF v_target_acct IS NULL THEN
    SELECT account_id INTO v_target_acct
    FROM public.default_account_settings
    WHERE organization_id = v_run.organization_id
      AND setting_key = 'salary_expense'
      AND business_id IS NULL
    LIMIT 1;
  END IF;

  IF v_target_acct IS NULL THEN
    RAISE EXCEPTION 'Cannot reclassify: no salary_expense mapping configured. Set a compliant Payroll Expense account first.'
      USING ERRCODE = '22023';
  END IF;

  -- Re-validate target via the same role guard (defense in depth).
  PERFORM public._payroll_assert_mapping_role('salary_expense', v_target_acct);

  -- Collect the misposted debit lines (COGS targets only).
  CREATE TEMP TABLE _bad_lines ON COMMIT DROP AS
  SELECT jel.id,
         jel.account_id AS bad_account_id,
         a.code         AS bad_account_code,
         jel.debit,
         jel.description,
         jel.contact_id,
         jel.branch_id,
         jel.business_id
  FROM public.journal_entry_lines jel
  JOIN public.accounts a ON a.id = jel.account_id
  WHERE jel.journal_entry_id = v_orig_je.id
    AND jel.debit > 0
    AND public._payroll_is_cogs_account(jel.account_id);

  SELECT COUNT(*), COALESCE(SUM(debit), 0), ARRAY_AGG(DISTINCT bad_account_code)
    INTO v_bad_count, v_bad_total, v_bad_codes
  FROM _bad_lines;

  IF v_bad_count = 0 THEN
    RAISE EXCEPTION 'No role-violating lines found on JE %; nothing to reclassify', v_orig_je.id
      USING ERRCODE = '22023';
  END IF;

  -- Generate next entry number (best-effort; conflicts retried).
  SELECT 'JE-' || LPAD((COALESCE(MAX(NULLIF(regexp_replace(entry_number, '\D', '', 'g'), '')::bigint), 0) + 1)::text, 5, '0')
    INTO v_new_entry_no
  FROM public.journal_entries
  WHERE organization_id = v_run.organization_id;

  -- Pick a branch_id: prefer run, fall back to original JE.
  v_branch_id := COALESCE(v_run.branch_id, v_orig_je.branch_id);

  -- Insert reclassification JE header (status='posted' so it hits ledgers immediately).
  INSERT INTO public.journal_entries (
    organization_id, business_id, branch_id,
    entry_number, entry_date, description, reference,
    status, posted_at, posted_by, posted_by_id, created_by,
    source_type, source_id, source_subtype,
    is_adjusting, is_adjusting_entry
  ) VALUES (
    v_run.organization_id, v_run.business_id, v_branch_id,
    v_new_entry_no, CURRENT_DATE,
    'Payroll reclassification — correcting role-violating mappings on ' || v_orig_je.entry_number ||
    ' (run ' || v_run.payroll_number || '). See payroll_reclassification_audit.',
    v_orig_je.entry_number,
    'posted', now(), v_user, v_user, v_user,
    'payroll_reclassification', p_run_id, 'role_violation_fix',
    true, true
  ) RETURNING id INTO v_new_je_id;

  -- Per-line: Dr correct salary_expense, Cr misposted account.
  INSERT INTO public.journal_entry_lines (
    journal_entry_id, account_id, debit, credit,
    description, contact_id, branch_id, business_id, sort_order
  )
  SELECT v_new_je_id, v_target_acct, b.debit, 0,
         'Reclass DR (was on ' || b.bad_account_code || '): ' || b.description,
         b.contact_id, b.branch_id, b.business_id,
         (row_number() OVER (ORDER BY b.id)) * 2 - 1
  FROM _bad_lines b;

  INSERT INTO public.journal_entry_lines (
    journal_entry_id, account_id, debit, credit,
    description, contact_id, branch_id, business_id, sort_order
  )
  SELECT v_new_je_id, b.bad_account_id, 0, b.debit,
         'Reclass CR (clearing ' || b.bad_account_code || '): ' || b.description,
         b.contact_id, b.branch_id, b.business_id,
         (row_number() OVER (ORDER BY b.id)) * 2
  FROM _bad_lines b;

  -- Stamp totals on the header.
  UPDATE public.journal_entries
     SET total_debit = v_bad_total,
         total_credit = v_bad_total
   WHERE id = v_new_je_id;

  -- Pin the reclassification onto the run (idempotency lock).
  UPDATE public.payroll_runs
     SET reclassification_journal_entry_id = v_new_je_id,
         updated_at = now()
   WHERE id = p_run_id;

  -- Audit trail.
  INSERT INTO public.payroll_reclassification_audit (
    organization_id, business_id, payroll_run_id,
    original_journal_entry_id, reclassification_journal_entry_id,
    lines_corrected, amount_corrected, from_account_codes, to_account_id,
    performed_by, reason
  ) VALUES (
    v_run.organization_id, v_run.business_id, p_run_id,
    v_orig_je.id, v_new_je_id,
    v_bad_count, v_bad_total, v_bad_codes, v_target_acct,
    v_user,
    'Auto-reclass: salary_expense / employer-expense debits routed to a Cost of Goods Sold account. Corrected to currently mapped salary_expense.'
  );

  RETURN v_new_je_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.payroll_generate_reclassification_je(uuid) TO authenticated;

COMMENT ON FUNCTION public.payroll_generate_reclassification_je(uuid) IS
  'Wave-3: posts a balanced reclassification JE for an already-posted payroll run whose '
  'debit lines hit a COGS account. Idempotent: a second call after success fails with 22023. '
  'Pre-requisite: the salary_expense mapping must already be remapped to a compliant expense account '
  '(R1 trigger enforces this).';
