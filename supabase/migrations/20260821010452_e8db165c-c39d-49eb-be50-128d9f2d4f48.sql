-- AR-6 — a rule is scoped like the line it explains.
ALTER TABLE public.bank_reconciliation_rules
  ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.bank_reconciliation_rules.branch_id IS
  'Branch this rule applies to. NULL = every branch of the business. A rule may never explain a line belonging to another branch.';

CREATE INDEX IF NOT EXISTS idx_brr_business_branch_priority
  ON public.bank_reconciliation_rules (business_id, branch_id, priority);

-- The executor and the evidence engine must both honour the scope. Both bodies
-- are large and unrelated to this change, so the predicate is inserted in place
-- rather than transcribed.
DO $mig$
DECLARE def text;
BEGIN
  def := pg_get_functiondef('public.apply_reconciliation_rules(uuid,uuid,integer)'::regprocedure);
  IF position('r.branch_id' IN def) = 0 THEN
    def := replace(
      def,
      'AND (r.bank_account_id IS NULL OR r.bank_account_id = _bank_account_id)',
      'AND (r.bank_account_id IS NULL OR r.bank_account_id = _bank_account_id)
      AND (r.branch_id IS NULL OR _txn.branch_id IS NULL OR r.branch_id = _txn.branch_id)'
    );
    EXECUTE def;
  END IF;

  def := pg_get_functiondef('public.bank_match_candidates(uuid,integer)'::regprocedure);
  IF position('r.branch_id' IN def) = 0 THEN
    def := replace(
      def,
      'AND (r.bank_account_id IS NULL OR r.bank_account_id = _txn.bank_account_id)',
      'AND (r.bank_account_id IS NULL OR r.bank_account_id = _txn.bank_account_id)
         AND (r.branch_id IS NULL OR _txn.branch_id IS NULL OR r.branch_id = _txn.branch_id)'
    );
    EXECUTE def;
  END IF;
END $mig$;

DO $verify$
BEGIN
  IF position('r.branch_id' IN (SELECT prosrc FROM pg_proc WHERE proname = 'apply_reconciliation_rules')) = 0 THEN
    RAISE EXCEPTION 'apply_reconciliation_rules did not pick up the branch filter';
  END IF;
  IF position('r.branch_id' IN (SELECT prosrc FROM pg_proc WHERE proname = 'bank_match_candidates')) = 0 THEN
    RAISE EXCEPTION 'bank_match_candidates did not pick up the branch filter';
  END IF;
END $verify$;

-- The authoring seam accepts the new scope and validates it, so a branch from
-- another company cannot be stamped onto a rule.
CREATE OR REPLACE FUNCTION public.bank_reconciliation_rule_upsert(
  _business_id uuid,
  _payload jsonb,
  _id uuid DEFAULT NULL::uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_org uuid;
  v_id uuid;
  v_bank_account_id uuid := NULLIF(_payload->>'bank_account_id','')::uuid;
  v_counterpart uuid := NULLIF(_payload->>'counterpart_account_id','')::uuid;
  v_branch uuid := NULLIF(_payload->>'branch_id','')::uuid;
  v_sign text := COALESCE(NULLIF(_payload->>'amount_sign',''),'any');
BEGIN
  IF _business_id IS NULL THEN
    RAISE EXCEPTION 'BANK_RULE_BUSINESS_REQUIRED' USING ERRCODE = '22023';
  END IF;
  PERFORM public.assert_can_reconcile_bank(_business_id);

  SELECT b.organization_id INTO v_org FROM public.businesses b WHERE b.id = _business_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'BANK_RULE_UNKNOWN_BUSINESS' USING ERRCODE = '22023';
  END IF;

  IF v_sign NOT IN ('debit','credit','any') THEN
    RAISE EXCEPTION 'BANK_RULE_INVALID_AMOUNT_SIGN: %', v_sign USING ERRCODE = '22023';
  END IF;

  IF v_counterpart IS NULL THEN
    RAISE EXCEPTION 'BANK_RULE_COUNTERPART_ACCOUNT_REQUIRED' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.accounts a
    WHERE a.id = v_counterpart AND a.business_id = _business_id
  ) THEN
    RAISE EXCEPTION 'BANK_RULE_COUNTERPART_ACCOUNT_FOREIGN' USING ERRCODE = '42501';
  END IF;

  IF v_bank_account_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.bank_accounts ba
    WHERE ba.id = v_bank_account_id AND ba.business_id = _business_id
  ) THEN
    RAISE EXCEPTION 'BANK_RULE_BANK_ACCOUNT_FOREIGN' USING ERRCODE = '42501';
  END IF;

  IF v_branch IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.branches br
    WHERE br.id = v_branch AND br.business_id = _business_id
  ) THEN
    RAISE EXCEPTION 'BANK_RULE_BRANCH_FOREIGN' USING ERRCODE = '42501';
  END IF;

  IF _id IS NULL THEN
    INSERT INTO public.bank_reconciliation_rules (
      organization_id, business_id, branch_id, bank_account_id, name, priority, is_active,
      description_pattern, description_regex, reference_pattern,
      amount_min, amount_max, amount_sign,
      counterpart_contact_id, counterpart_account_id, journal_book_id,
      auto_post, description_template, created_by
    ) VALUES (
      v_org, _business_id, v_branch, v_bank_account_id,
      COALESCE(NULLIF(_payload->>'name',''), 'Untitled rule'),
      COALESCE((_payload->>'priority')::int, 100),
      COALESCE((_payload->>'is_active')::boolean, true),
      NULLIF(_payload->>'description_pattern',''),
      NULLIF(_payload->>'description_regex',''),
      NULLIF(_payload->>'reference_pattern',''),
      NULLIF(_payload->>'amount_min','')::numeric,
      NULLIF(_payload->>'amount_max','')::numeric,
      v_sign,
      NULLIF(_payload->>'counterpart_contact_id','')::uuid,
      v_counterpart,
      NULLIF(_payload->>'journal_book_id','')::uuid,
      COALESCE((_payload->>'auto_post')::boolean, false),
      NULLIF(_payload->>'description_template',''),
      auth.uid()
    ) RETURNING id INTO v_id;
  ELSE
    UPDATE public.bank_reconciliation_rules r SET
      bank_account_id = v_bank_account_id,
      branch_id = v_branch,
      name = COALESCE(NULLIF(_payload->>'name',''), r.name),
      priority = COALESCE((_payload->>'priority')::int, r.priority),
      is_active = COALESCE((_payload->>'is_active')::boolean, r.is_active),
      description_pattern = NULLIF(_payload->>'description_pattern',''),
      description_regex = NULLIF(_payload->>'description_regex',''),
      reference_pattern = NULLIF(_payload->>'reference_pattern',''),
      amount_min = NULLIF(_payload->>'amount_min','')::numeric,
      amount_max = NULLIF(_payload->>'amount_max','')::numeric,
      amount_sign = v_sign,
      counterpart_contact_id = NULLIF(_payload->>'counterpart_contact_id','')::uuid,
      counterpart_account_id = v_counterpart,
      journal_book_id = NULLIF(_payload->>'journal_book_id','')::uuid,
      auto_post = COALESCE((_payload->>'auto_post')::boolean, r.auto_post),
      description_template = NULLIF(_payload->>'description_template',''),
      updated_at = now()
    WHERE r.id = _id AND r.business_id = _business_id
    RETURNING r.id INTO v_id;

    IF v_id IS NULL THEN
      RAISE EXCEPTION 'BANK_RULE_NOT_FOUND_IN_BUSINESS' USING ERRCODE = 'P0002';
    END IF;
  END IF;

  RETURN v_id;
END;
$fn$;

REVOKE ALL ON FUNCTION public.bank_reconciliation_rule_upsert(uuid, jsonb, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bank_reconciliation_rule_upsert(uuid, jsonb, uuid) TO authenticated;