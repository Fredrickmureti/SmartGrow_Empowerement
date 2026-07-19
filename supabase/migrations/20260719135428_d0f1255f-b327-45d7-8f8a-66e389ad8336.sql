
-- =========================================================================
-- POS Posting Queue — operational workspace back-end
-- Single accounting authority: reuse the same resolvers as
-- post_pos_statement_gl so the workspace UI can never disagree with the
-- posting engine.
-- =========================================================================

-- ---- 1. Audit table --------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.pos_statement_posting_retries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  branch_id uuid,
  statement_id uuid NOT NULL REFERENCES public.pos_statements(id) ON DELETE CASCADE,
  shift_id uuid,
  requested_by uuid NOT NULL,
  reason text,
  idempotency_key text NOT NULL,
  outbox_event_id uuid,
  requested_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.pos_statement_posting_retries TO authenticated;
GRANT ALL    ON public.pos_statement_posting_retries TO service_role;

ALTER TABLE public.pos_statement_posting_retries ENABLE ROW LEVEL SECURITY;

CREATE POLICY pos_stmt_retry_read ON public.pos_statement_posting_retries
  FOR SELECT TO authenticated
  USING (public.user_can_access_branch(auth.uid(), branch_id));

CREATE INDEX IF NOT EXISTS ix_pos_stmt_retry_stmt ON public.pos_statement_posting_retries(statement_id, requested_at DESC);

-- ---- 2. Read-only preview RPC ---------------------------------------------
-- Mirrors post_pos_statement_gl's account resolution logic, but never raises;
-- unresolved mappings are returned in `unresolved[]` so the UI can guide the
-- accountant to the exact missing key in default_account_settings.

CREATE OR REPLACE FUNCTION public.get_pos_statement_posting_preview(p_statement_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_stmt          public.pos_statements%ROWTYPE;
  v_net_revenue   numeric := 0;
  v_tax_amt       numeric := 0;
  v_tip_amt       numeric := 0;
  v_tender        RECORD;
  v_pm_id         uuid;
  v_kind          text;
  v_acct          uuid;
  v_tenders       jsonb := '[]'::jsonb;
  v_revenue       jsonb := NULL;
  v_tax           jsonb := NULL;
  v_tip           jsonb := NULL;
  v_unresolved    jsonb := '[]'::jsonb;
  v_td            numeric := 0;
  v_tc            numeric := 0;
BEGIN
  SELECT * INTO v_stmt FROM public.pos_statements WHERE id = p_statement_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error','statement_not_found');
  END IF;

  v_net_revenue := COALESCE(v_stmt.total_sales,0) - COALESCE(v_stmt.total_returns,0)
                 - COALESCE(v_stmt.total_tax,0);
  v_tax_amt := COALESCE(v_stmt.total_tax, 0);
  v_tip_amt := COALESCE(v_stmt.total_tip, 0);

  -- Tenders
  FOR v_tender IN
    SELECT tender_method, processor,
           SUM(net_amount)   AS net_amt,
           SUM(gross_amount) AS gross,
           SUM(refund_amount) AS refunds
      FROM public.pos_statement_tender_lines
     WHERE statement_id = v_stmt.id
     GROUP BY tender_method, processor
  LOOP
    SELECT id, tender_kind INTO v_pm_id, v_kind
      FROM public.pos_payment_methods
     WHERE business_id = v_stmt.business_id
       AND method_key  = v_tender.tender_method
     ORDER BY (branch_id = v_stmt.branch_id) DESC NULLS LAST
     LIMIT 1;

    v_acct := public.resolve_pos_tender_gl_account(
                v_stmt.business_id, v_stmt.branch_id,
                COALESCE(v_kind, v_tender.tender_method),
                v_tender.processor,
                v_pm_id);

    v_tenders := v_tenders || jsonb_build_array(jsonb_build_object(
      'tender_method',  v_tender.tender_method,
      'processor',      v_tender.processor,
      'tender_kind',    v_kind,
      'net_amount',     v_tender.net_amt,
      'gross_amount',   v_tender.gross,
      'refund_amount',  v_tender.refunds,
      'account_id',     v_acct,
      'resolved',       v_acct IS NOT NULL
    ));

    IF v_acct IS NULL AND COALESCE(v_tender.net_amt,0) <> 0 THEN
      v_unresolved := v_unresolved || jsonb_build_array(jsonb_build_object(
        'kind',   'tender',
        'key',    v_tender.tender_method || COALESCE(':' || v_tender.processor,''),
        'amount', v_tender.net_amt,
        'hint',   'Map tender via Finance → Default Accounts (tender kind '
                  || COALESCE(v_kind, v_tender.tender_method) || ') or pos_payment_methods.debit_account_id.'
      ));
    ELSIF v_acct IS NOT NULL AND COALESCE(v_tender.net_amt,0) <> 0 THEN
      v_td := v_td + CASE WHEN v_tender.net_amt >= 0 THEN v_tender.net_amt ELSE 0 END;
      v_tc := v_tc + CASE WHEN v_tender.net_amt <  0 THEN -v_tender.net_amt ELSE 0 END;
    END IF;
  END LOOP;

  -- Revenue
  IF v_net_revenue <> 0 THEN
    v_acct := COALESCE(
      public.get_default_account_id(v_stmt.organization_id, v_stmt.business_id, 'pos_revenue'),
      public.get_default_account_id(v_stmt.organization_id, v_stmt.business_id, 'sales_revenue'));
    v_revenue := jsonb_build_object(
      'amount', v_net_revenue,
      'account_id', v_acct,
      'resolved', v_acct IS NOT NULL,
      'setting_keys', jsonb_build_array('pos_revenue','sales_revenue')
    );
    IF v_acct IS NULL THEN
      v_unresolved := v_unresolved || jsonb_build_array(jsonb_build_object(
        'kind','revenue','key','pos_revenue',
        'amount', v_net_revenue,
        'hint','Map pos_revenue (or sales_revenue) in Finance → Default Accounts for this business.'));
    ELSE
      v_tc := v_tc + CASE WHEN v_net_revenue > 0 THEN v_net_revenue ELSE 0 END;
      v_td := v_td + CASE WHEN v_net_revenue < 0 THEN -v_net_revenue ELSE 0 END;
    END IF;
  END IF;

  -- Tax
  IF v_tax_amt <> 0 THEN
    v_acct := COALESCE(
      public.get_default_account_id(v_stmt.organization_id, v_stmt.business_id, 'pos_tax_payable'),
      public.get_default_account_id(v_stmt.organization_id, v_stmt.business_id, 'tax_payable'),
      public.get_default_account_id(v_stmt.organization_id, v_stmt.business_id, 'sales_tax_payable'));
    v_tax := jsonb_build_object(
      'amount', v_tax_amt,
      'account_id', v_acct,
      'resolved', v_acct IS NOT NULL,
      'setting_keys', jsonb_build_array('pos_tax_payable','tax_payable','sales_tax_payable')
    );
    IF v_acct IS NULL THEN
      v_unresolved := v_unresolved || jsonb_build_array(jsonb_build_object(
        'kind','tax','key','pos_tax_payable',
        'amount', v_tax_amt,
        'hint','Map pos_tax_payable (or tax_payable / sales_tax_payable) in Finance → Default Accounts.'));
    ELSE
      v_tc := v_tc + v_tax_amt;
    END IF;
  END IF;

  -- Tip
  IF v_tip_amt <> 0 THEN
    v_acct := public.get_default_account_id(v_stmt.organization_id, v_stmt.business_id, 'tip_liability');
    v_tip := jsonb_build_object(
      'amount', v_tip_amt,
      'account_id', v_acct,
      'resolved', v_acct IS NOT NULL,
      'setting_keys', jsonb_build_array('tip_liability'),
      'optional', true
    );
    -- Tip is optional in the poster (silently skipped); still surface for visibility.
    IF v_acct IS NOT NULL THEN
      v_tc := v_tc + v_tip_amt;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'statement_id',      v_stmt.id,
    'statement_number',  v_stmt.statement_number,
    'shift_id',          v_stmt.shift_id,
    'business_id',       v_stmt.business_id,
    'branch_id',         v_stmt.branch_id,
    'posting_status',    v_stmt.posting_status,
    'close_kind',        v_stmt.close_kind,
    'closed_at',         v_stmt.closed_at,
    'journal_entry_id',  v_stmt.journal_entry_id,
    'total_sales',       v_stmt.total_sales,
    'total_returns',     v_stmt.total_returns,
    'total_tax',         v_stmt.total_tax,
    'total_tip',         v_stmt.total_tip,
    'net_revenue',       v_net_revenue,
    'tenders',           v_tenders,
    'revenue',           v_revenue,
    'tax',               v_tax,
    'tip',               v_tip,
    'unresolved',        v_unresolved,
    'total_debit',       v_td,
    'total_credit',      v_tc,
    'balanced',          ABS(v_td - v_tc) <= 0.01,
    'ready_to_post',     jsonb_array_length(v_unresolved) = 0
                         AND v_stmt.closed_at IS NOT NULL
                         AND v_stmt.posting_status = 'pending'::pos_statement_posting_status
  );
END $fn$;

REVOKE ALL ON FUNCTION public.get_pos_statement_posting_preview(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_pos_statement_posting_preview(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.get_pos_statement_posting_preview(uuid) IS
  'Dry-run preview of post_pos_statement_gl. Same resolver chain (resolve_pos_tender_gl_account + get_default_account_id) as the authoritative poster; never raises. Surfaces every unresolved canonical mapping key in `unresolved[]` so the operational workspace can guide the accountant to the exact missing default_account_settings row.';

-- ---- 3. Retry RPC ---------------------------------------------------------
-- Re-enqueues the pos.statement.posting.requested event so the outbox
-- dispatcher re-runs post_pos_statement_gl. UI never calls the poster
-- directly (post_pos_statement_gl is service_role only).

CREATE OR REPLACE FUNCTION public.retry_pos_statement_posting(
  p_statement_id uuid,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_stmt        public.pos_statements%ROWTYPE;
  v_key         text;
  v_outbox_id   uuid;
  v_uid         uuid := auth.uid();
  v_allowed     boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'retry_pos_statement_posting: authentication required'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_stmt FROM public.pos_statements WHERE id = p_statement_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'retry_pos_statement_posting: statement % not found', p_statement_id
      USING ERRCODE = 'P0002';
  END IF;

  v_allowed := public.has_role(v_uid, 'admin'::app_role)
            OR public.has_role(v_uid, 'owner'::app_role)
            OR public.has_role(v_uid, 'super_admin'::app_role)
            OR public.has_role(v_uid, 'accountant'::app_role);
  IF NOT v_allowed THEN
    RAISE EXCEPTION 'retry_pos_statement_posting: not permitted (admin, owner, super_admin, or accountant required)'
      USING ERRCODE = '42501';
  END IF;

  IF v_stmt.posting_status = 'posted'::pos_statement_posting_status THEN
    RETURN jsonb_build_object(
      'statement_id', v_stmt.id, 'already_posted', true,
      'journal_entry_id', v_stmt.journal_entry_id);
  END IF;
  IF v_stmt.closed_at IS NULL THEN
    RAISE EXCEPTION 'retry_pos_statement_posting: statement % is not closed', v_stmt.id
      USING ERRCODE = '22023';
  END IF;
  IF v_stmt.close_kind = 'historical_backfill'::pos_statement_close_kind THEN
    RAISE EXCEPTION 'retry_pos_statement_posting: historical backfill statements do not post'
      USING ERRCODE = '22023';
  END IF;

  v_key := 'pos-stmt-post-' || v_stmt.id::text || '-retry-' || (extract(epoch FROM now())::bigint)::text;

  INSERT INTO public.business_event_outbox
    (org_id, branch_id, event_type, source_doc_type, source_doc_id,
     payload, source, idempotency_key, actor_user_id, handler_scope)
  VALUES
    (v_stmt.organization_id, v_stmt.branch_id,
     'pos.statement.posting.requested',
     'pos_statement', v_stmt.id,
     jsonb_build_object(
       'statement_id',     v_stmt.id,
       'statement_number', v_stmt.statement_number,
       'shift_id',         v_stmt.shift_id,
       'close_kind',       v_stmt.close_kind,
       'total_sales',      v_stmt.total_sales,
       'total_returns',    v_stmt.total_returns,
       'total_tax',        v_stmt.total_tax,
       'retry',            true,
       'requested_by',     v_uid,
       'reason',           p_reason
     ),
     'pos', v_key, v_uid, 'server')
  RETURNING id INTO v_outbox_id;

  INSERT INTO public.pos_statement_posting_retries
    (organization_id, business_id, branch_id, statement_id, shift_id,
     requested_by, reason, idempotency_key, outbox_event_id)
  VALUES
    (v_stmt.organization_id, v_stmt.business_id, v_stmt.branch_id,
     v_stmt.id, v_stmt.shift_id, v_uid, p_reason, v_key, v_outbox_id);

  RETURN jsonb_build_object(
    'statement_id', v_stmt.id,
    'outbox_event_id', v_outbox_id,
    'idempotency_key', v_key,
    'queued', true);
END $fn$;

REVOKE ALL ON FUNCTION public.retry_pos_statement_posting(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.retry_pos_statement_posting(uuid, text) TO authenticated;

COMMENT ON FUNCTION public.retry_pos_statement_posting(uuid, text) IS
  'Permission-gated (admin/owner/super_admin/accountant). Enqueues a fresh pos.statement.posting.requested outbox event so the async dispatcher re-runs post_pos_statement_gl. UI never calls the poster directly. Idempotency key carries an epoch suffix so retries are always distinct rows in the outbox.';

-- ---- 4. Deprecate the legacy summary --------------------------------------
COMMENT ON FUNCTION public.get_pos_shift_gl_summary(uuid) IS
  'DEPRECATED. Aggregates by legacy per-product accounts (products.sales_account_id, products.cogs_account_id) that are NOT read by the authoritative POS statement poster. Use get_pos_statement_posting_preview(statement_id) for any accounting decision.';
