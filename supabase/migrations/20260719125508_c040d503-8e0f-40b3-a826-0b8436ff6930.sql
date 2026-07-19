
-- =========================================================================
-- POS S5 — GL cutover: statement-centric posting in shadow mode (retry)
-- =========================================================================

CREATE TABLE IF NOT EXISTS public.pos_gl_shadow_postings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  branch_id uuid,
  transaction_id uuid NOT NULL,
  transaction_number text,
  transaction_type text NOT NULL,
  shift_id uuid,
  net_amount numeric NOT NULL DEFAULT 0,
  tax_amount numeric NOT NULL DEFAULT 0,
  cogs_amount numeric NOT NULL DEFAULT 0,
  tender_breakdown jsonb NOT NULL DEFAULT '{}'::jsonb,
  proposed_lines jsonb NOT NULL DEFAULT '[]'::jsonb,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (transaction_id)
);
GRANT SELECT ON public.pos_gl_shadow_postings TO authenticated;
GRANT ALL    ON public.pos_gl_shadow_postings TO service_role;
ALTER TABLE public.pos_gl_shadow_postings ENABLE ROW LEVEL SECURITY;
CREATE POLICY pos_gl_shadow_read ON public.pos_gl_shadow_postings
  FOR SELECT TO authenticated
  USING (public.user_can_access_branch(auth.uid(), branch_id));

CREATE TABLE IF NOT EXISTS public.pos_statement_gl_apply_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  statement_id uuid NOT NULL REFERENCES public.pos_statements(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  journal_entry_id uuid,
  posted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (statement_id, idempotency_key)
);
GRANT SELECT ON public.pos_statement_gl_apply_log TO authenticated;
GRANT ALL    ON public.pos_statement_gl_apply_log TO service_role;
ALTER TABLE public.pos_statement_gl_apply_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY pos_stmt_gl_log_read ON public.pos_statement_gl_apply_log
  FOR SELECT TO authenticated
  USING (statement_id IN (
    SELECT id FROM public.pos_statements s WHERE public.user_can_access_branch(auth.uid(), s.branch_id)
  ));

INSERT INTO public.business_event_topics
  (topic_prefix, producer_domain, consumer_domains, description, handler_scope, max_attempts)
VALUES
  ('pos.statement.posting.requested', 'pos', ARRAY['finance']::text[],
   'POS statement is closed and requests GL posting. Drained server-side by post_pos_statement_gl.',
   'server', 10)
ON CONFLICT (topic_prefix) DO UPDATE
  SET handler_scope='server', producer_domain='pos', consumer_domains=EXCLUDED.consumer_domains,
      description=EXCLUDED.description, updated_at=now();

CREATE OR REPLACE FUNCTION public._pos_stmt_enqueue_gl_post()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $fn$
BEGIN
  IF NEW.closed_at IS NOT NULL
     AND NEW.posting_status = 'pending'
     AND NEW.close_kind <> 'historical_backfill'::pos_statement_close_kind
     AND (TG_OP = 'INSERT'
          OR OLD.closed_at IS NULL
          OR OLD.posting_status <> 'pending')
  THEN
    INSERT INTO public.business_event_outbox
      (org_id, business_id, branch_id, event_type, source_doc_type, source_doc_id,
       payload, source, idempotency_key)
    VALUES
      (NEW.organization_id, NEW.business_id, NEW.branch_id,
       'pos.statement.posting.requested',
       'pos_statement', NEW.id,
       jsonb_build_object(
         'statement_id',     NEW.id,
         'statement_number', NEW.statement_number,
         'shift_id',         NEW.shift_id,
         'close_kind',       NEW.close_kind,
         'total_sales',      NEW.total_sales,
         'total_returns',    NEW.total_returns,
         'total_tax',        NEW.total_tax
       ),
       'pos'::event_source_domain::text,
       'pos-stmt-post-' || NEW.id::text)
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS trg_pos_stmt_enqueue_gl_post ON public.pos_statements;
CREATE TRIGGER trg_pos_stmt_enqueue_gl_post
  AFTER INSERT OR UPDATE OF closed_at, posting_status ON public.pos_statements
  FOR EACH ROW EXECUTE FUNCTION public._pos_stmt_enqueue_gl_post();

CREATE OR REPLACE FUNCTION public.post_pos_statement_gl(
  p_statement_id uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_stmt         public.pos_statements%ROWTYPE;
  v_key          text;
  v_existing_je  uuid;
  v_lines        jsonb := '[]'::jsonb;
  v_line         jsonb;
  v_tot_tender   numeric := 0;
  v_net_revenue  numeric := 0;
  v_tax_amt      numeric := 0;
  v_tip_amt      numeric := 0;
  v_entry_number text;
  v_je_id        uuid;
  v_acct         uuid;
  v_pm_id        uuid;
  v_kind         text;
  v_tender       RECORD;
  v_actor        uuid;
  v_td           numeric;
  v_tc           numeric;
BEGIN
  SELECT * INTO v_stmt FROM public.pos_statements WHERE id = p_statement_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'post_pos_statement_gl: statement % not found', p_statement_id
      USING ERRCODE = 'P0002';
  END IF;

  IF v_stmt.close_kind = 'historical_backfill'::pos_statement_close_kind THEN
    RETURN jsonb_build_object('statement_id', v_stmt.id, 'skipped', true, 'reason', 'historical_backfill');
  END IF;
  IF v_stmt.closed_at IS NULL THEN
    RAISE EXCEPTION 'post_pos_statement_gl: statement % is not closed', p_statement_id
      USING ERRCODE = '22023';
  END IF;
  IF v_stmt.posting_status = 'posted'::pos_statement_posting_status THEN
    RETURN jsonb_build_object('statement_id', v_stmt.id, 'journal_entry_id', v_stmt.journal_entry_id,
                              'already_posted', true);
  END IF;
  IF v_stmt.posting_status = 'reversed'::pos_statement_posting_status THEN
    RAISE EXCEPTION 'post_pos_statement_gl: statement % is reversed', p_statement_id
      USING ERRCODE = '22023';
  END IF;

  v_key := COALESCE(p_idempotency_key, v_stmt.idempotency_key, 'stmt:' || v_stmt.id::text);

  SELECT journal_entry_id INTO v_existing_je
    FROM public.pos_statement_gl_apply_log
   WHERE statement_id = v_stmt.id AND idempotency_key = v_key;
  IF v_existing_je IS NOT NULL THEN
    RETURN jsonb_build_object('statement_id', v_stmt.id, 'journal_entry_id', v_existing_je,
                              'already_posted', true, 'via', 'apply_log');
  END IF;

  v_actor := COALESCE(v_stmt.closed_by, v_stmt.opened_by);

  v_net_revenue := COALESCE(v_stmt.total_sales,0) - COALESCE(v_stmt.total_returns,0)
                 - COALESCE(v_stmt.total_tax,0);
  v_tax_amt     := COALESCE(v_stmt.total_tax, 0);
  v_tip_amt     := COALESCE(v_stmt.total_tip, 0);

  FOR v_tender IN
    SELECT tender_method, processor,
           SUM(net_amount)    AS net_amt,
           SUM(gross_amount)  AS gross,
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

    IF v_acct IS NULL THEN
      RAISE EXCEPTION 'post_pos_statement_gl: no GL account resolved for tender % (processor %) on statement %',
        v_tender.tender_method, COALESCE(v_tender.processor,'<none>'), v_stmt.id
        USING ERRCODE = 'check_violation';
    END IF;

    IF COALESCE(v_tender.net_amt,0) <> 0 THEN
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account_id', v_acct,
        'debit',  CASE WHEN v_tender.net_amt >= 0 THEN v_tender.net_amt      ELSE 0 END,
        'credit', CASE WHEN v_tender.net_amt <  0 THEN -v_tender.net_amt     ELSE 0 END,
        'description',
          'POS ' || v_tender.tender_method
          || COALESCE(' / ' || v_tender.processor, '')
          || ' — statement ' || v_stmt.statement_number,
        'branch_id', v_stmt.branch_id));
      v_tot_tender := v_tot_tender + v_tender.net_amt;
    END IF;
  END LOOP;

  IF v_net_revenue <> 0 THEN
    v_acct := COALESCE(
      public.get_default_account_id(v_stmt.organization_id, v_stmt.business_id, 'pos_revenue'),
      public.get_default_account_id(v_stmt.organization_id, v_stmt.business_id, 'sales_revenue'));
    IF v_acct IS NULL THEN
      RAISE EXCEPTION 'post_pos_statement_gl: no revenue account (pos_revenue/sales_revenue) mapped for business %',
        v_stmt.business_id USING ERRCODE = 'check_violation';
    END IF;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', v_acct,
      'debit',  CASE WHEN v_net_revenue < 0 THEN -v_net_revenue ELSE 0 END,
      'credit', CASE WHEN v_net_revenue > 0 THEN  v_net_revenue ELSE 0 END,
      'description', 'POS revenue — statement ' || v_stmt.statement_number,
      'branch_id', v_stmt.branch_id));
  END IF;

  IF v_tax_amt <> 0 THEN
    v_acct := COALESCE(
      public.get_default_account_id(v_stmt.organization_id, v_stmt.business_id, 'pos_tax_payable'),
      public.get_default_account_id(v_stmt.organization_id, v_stmt.business_id, 'tax_payable'),
      public.get_default_account_id(v_stmt.organization_id, v_stmt.business_id, 'sales_tax_payable'));
    IF v_acct IS NULL THEN
      RAISE EXCEPTION 'post_pos_statement_gl: no tax-payable account mapped for business %',
        v_stmt.business_id USING ERRCODE = 'check_violation';
    END IF;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', v_acct,
      'debit',  0,
      'credit', v_tax_amt,
      'description', 'POS output tax — statement ' || v_stmt.statement_number,
      'branch_id', v_stmt.branch_id));
  END IF;

  IF v_tip_amt <> 0 THEN
    v_acct := public.get_default_account_id(v_stmt.organization_id, v_stmt.business_id, 'tip_liability');
    IF v_acct IS NOT NULL THEN
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account_id', v_acct,
        'debit',  0,
        'credit', v_tip_amt,
        'description', 'POS tips liability — statement ' || v_stmt.statement_number,
        'branch_id', v_stmt.branch_id));
    END IF;
  END IF;

  IF jsonb_array_length(v_lines) < 2 THEN
    UPDATE public.pos_statements
       SET posting_status = 'posted'::pos_statement_posting_status,
           posted_at = now(),
           idempotency_key = v_key,
           updated_at = now()
     WHERE id = v_stmt.id;
    INSERT INTO public.pos_statement_gl_apply_log(statement_id, idempotency_key, journal_entry_id)
      VALUES (v_stmt.id, v_key, NULL);
    RETURN jsonb_build_object('statement_id', v_stmt.id, 'journal_entry_id', NULL, 'empty', true);
  END IF;

  v_td := 0; v_tc := 0;
  FOR v_line IN SELECT * FROM jsonb_array_elements(v_lines) LOOP
    v_td := v_td + COALESCE((v_line->>'debit')::numeric,  0);
    v_tc := v_tc + COALESCE((v_line->>'credit')::numeric, 0);
  END LOOP;
  IF ABS(v_td - v_tc) > 0.01 THEN
    RAISE EXCEPTION 'post_pos_statement_gl: unbalanced entry for statement % (debit=%, credit=%)',
      v_stmt.id, v_td, v_tc USING ERRCODE = 'check_violation';
  END IF;

  SELECT COALESCE(
    'JE-' || LPAD(
      (COALESCE(MAX(NULLIF(regexp_replace(entry_number, '[^0-9]', '', 'g'), ''))::int, 0) + 1)::text,
      5, '0'), 'JE-00001')
    INTO v_entry_number
    FROM public.journal_entries WHERE organization_id = v_stmt.organization_id;

  v_je_id := public.post_journal_entry_atomic(
    v_stmt.organization_id, v_stmt.business_id, v_entry_number,
    v_stmt.closed_at::date,
    'POS-STMT-' || v_stmt.statement_number,
    'POS statement close — ' || v_stmt.statement_number,
    'pos_statement', v_stmt.id, v_actor,
    false, false, v_lines, NULL, NULL, NULL, v_stmt.branch_id);

  UPDATE public.pos_statements
     SET posting_status = 'posted'::pos_statement_posting_status,
         journal_entry_id = v_je_id,
         posted_at = now(),
         idempotency_key = v_key,
         updated_at = now()
   WHERE id = v_stmt.id;

  INSERT INTO public.pos_statement_gl_apply_log(statement_id, idempotency_key, journal_entry_id)
    VALUES (v_stmt.id, v_key, v_je_id);

  RETURN jsonb_build_object(
    'statement_id', v_stmt.id,
    'journal_entry_id', v_je_id,
    'entry_number', v_entry_number,
    'tender_total', v_tot_tender);
END $fn$;

REVOKE ALL ON FUNCTION public.post_pos_statement_gl(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.post_pos_statement_gl(uuid, text) TO service_role;

CREATE OR REPLACE FUNCTION public.post_pos_sale_gl(_txn_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_txn RECORD;
  v_net numeric := 0;
  v_cogs numeric := 0;
  v_tax numeric := 0;
  v_tenders jsonb := '{}'::jsonb;
BEGIN
  SELECT * INTO v_txn FROM public.pos_transactions WHERE id = _txn_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF v_txn.status <> 'completed' THEN RETURN NULL; END IF;
  IF v_txn.transaction_type NOT IN ('sale','return') THEN RETURN NULL; END IF;

  v_net := COALESCE(v_txn.subtotal, 0) - COALESCE(v_txn.discount_amount, 0);
  SELECT COALESCE(SUM(cost_price * quantity), 0) INTO v_cogs
    FROM public.pos_transaction_items WHERE transaction_id = _txn_id;
  SELECT COALESCE(SUM(tax_amount), 0) INTO v_tax
    FROM public.pos_transaction_items WHERE transaction_id = _txn_id;
  SELECT COALESCE(jsonb_object_agg(payment_method, amt), '{}'::jsonb) INTO v_tenders
    FROM (SELECT payment_method, SUM(amount) AS amt
            FROM public.pos_transaction_payments
           WHERE transaction_id = _txn_id AND status = 'completed'
           GROUP BY payment_method) t;

  INSERT INTO public.pos_gl_shadow_postings(
    organization_id, business_id, branch_id, transaction_id, transaction_number,
    transaction_type, shift_id, net_amount, tax_amount, cogs_amount,
    tender_breakdown, proposed_lines, reason)
  VALUES (
    v_txn.organization_id, v_txn.business_id, v_txn.branch_id,
    v_txn.id, v_txn.transaction_number, v_txn.transaction_type, v_txn.shift_id,
    v_net, v_tax, v_cogs, v_tenders, '[]'::jsonb,
    'shadow_mode: per-sale posting demoted; statement-centric posting is authoritative')
  ON CONFLICT (transaction_id) DO UPDATE SET
    net_amount = EXCLUDED.net_amount,
    tax_amount = EXCLUDED.tax_amount,
    cogs_amount = EXCLUDED.cogs_amount,
    tender_breakdown = EXCLUDED.tender_breakdown;

  RETURN NULL;
END $fn$;

CREATE OR REPLACE VIEW public.v_pos_gl_posting_drift AS
WITH shadow_by_shift AS (
  SELECT s.organization_id, s.business_id, s.branch_id, s.shift_id,
         SUM(s.net_amount + s.tax_amount) AS shadow_gross,
         SUM(s.tax_amount)                AS shadow_tax,
         COUNT(*)                         AS shadow_tx_count
    FROM public.pos_gl_shadow_postings s
   WHERE s.shift_id IS NOT NULL
   GROUP BY s.organization_id, s.business_id, s.branch_id, s.shift_id
),
stmt_by_shift AS (
  SELECT st.organization_id, st.business_id, st.branch_id, st.shift_id, st.id AS statement_id,
         st.statement_number, st.posting_status, st.journal_entry_id,
         (st.total_sales - st.total_returns) AS statement_gross,
         st.total_tax                       AS statement_tax,
         st.total_transactions              AS statement_tx_count
    FROM public.pos_statements st
   WHERE st.close_kind <> 'historical_backfill'::pos_statement_close_kind
)
SELECT
  st.statement_id, st.statement_number, st.posting_status, st.journal_entry_id,
  st.organization_id, st.business_id, st.branch_id, st.shift_id,
  COALESCE(sh.shadow_gross, 0)   AS shadow_gross,
  st.statement_gross,
  (COALESCE(sh.shadow_gross,0) - st.statement_gross) AS delta_gross,
  COALESCE(sh.shadow_tax, 0)     AS shadow_tax,
  st.statement_tax,
  (COALESCE(sh.shadow_tax,0) - st.statement_tax) AS delta_tax,
  COALESCE(sh.shadow_tx_count,0) AS shadow_tx_count,
  st.statement_tx_count
FROM stmt_by_shift st
LEFT JOIN shadow_by_shift sh USING (organization_id, business_id, branch_id, shift_id);

GRANT SELECT ON public.v_pos_gl_posting_drift TO authenticated;
