
CREATE TABLE IF NOT EXISTS public.pos_card_settlement_gl_apply_log (
  settlement_id     UUID PRIMARY KEY
                    REFERENCES public.pos_card_settlements(id) ON DELETE CASCADE,
  journal_entry_id  UUID NOT NULL,
  applied_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_by        UUID
);

GRANT SELECT ON public.pos_card_settlement_gl_apply_log TO authenticated;
GRANT ALL    ON public.pos_card_settlement_gl_apply_log TO service_role;

ALTER TABLE public.pos_card_settlement_gl_apply_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "pos_settlement_gl_apply_log_read_business_members"
  ON public.pos_card_settlement_gl_apply_log FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.pos_card_settlements s
      JOIN public.user_business_access uba
        ON uba.business_id = s.business_id
      WHERE s.id = pos_card_settlement_gl_apply_log.settlement_id
        AND uba.user_id = auth.uid()
    )
  );

CREATE OR REPLACE FUNCTION public.pos_card_settlement_post_gl(
  p_settlement_id UUID
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row              public.pos_card_settlements%ROWTYPE;
  v_existing_log     public.pos_card_settlement_gl_apply_log%ROWTYPE;
  v_acct_clearing    UUID;
  v_acct_bank        UUID;
  v_acct_fees        UUID;
  v_acct_shortover   UUID;
  v_expected         NUMERIC;
  v_actual           NUMERIC;
  v_fee_total        NUMERIC;
  v_diff             NUMERIC;
  v_lines            jsonb := '[]'::jsonb;
  v_entry_id         UUID;
  v_entry_number     TEXT;
BEGIN
  SELECT * INTO v_row FROM public.pos_card_settlements
    WHERE id = p_settlement_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pos_card_settlement_post_gl: settlement % not found', p_settlement_id;
  END IF;
  IF v_row.status = 'open' THEN
    RAISE EXCEPTION 'pos_card_settlement_post_gl: settlement % is still open', p_settlement_id;
  END IF;
  IF v_row.actual_amount IS NULL THEN
    RAISE EXCEPTION 'pos_card_settlement_post_gl: settlement % has no actual_amount', p_settlement_id;
  END IF;

  SELECT * INTO v_existing_log FROM public.pos_card_settlement_gl_apply_log
    WHERE settlement_id = p_settlement_id;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'settlement_id',    p_settlement_id,
      'journal_entry_id', v_existing_log.journal_entry_id,
      'status',           'already_posted'
    );
  END IF;

  v_expected  := COALESCE(v_row.expected_amount, 0);
  v_actual    := COALESCE(v_row.actual_amount, 0);
  v_fee_total := COALESCE(v_row.fee_total, 0);

  v_acct_clearing  := public.resolve_default_account(v_row.business_id, 'pos_card_clearing',        v_row.branch_id);
  v_acct_bank      := public.resolve_default_account(v_row.business_id, 'pos_card_bank_clearing',   v_row.branch_id);
  v_acct_fees      := public.resolve_default_account(v_row.business_id, 'pos_card_processing_fees', v_row.branch_id);
  v_acct_shortover := public.resolve_default_account(v_row.business_id, 'pos_cash_short_over',      v_row.branch_id);

  IF v_acct_clearing IS NULL OR v_acct_bank IS NULL
     OR v_acct_fees IS NULL OR v_acct_shortover IS NULL THEN
    RAISE EXCEPTION
      'pos_card_settlement_post_gl: missing default_accounts for business=% (clearing=%, bank=%, fees=%, short_over=%)',
      v_row.business_id, v_acct_clearing, v_acct_bank, v_acct_fees, v_acct_shortover;
  END IF;

  v_lines := v_lines || jsonb_build_array(jsonb_build_object(
    'account_id', v_acct_clearing,
    'debit', 0, 'credit', v_expected,
    'description', 'Card clearing — batch ' || p_settlement_id::text
  ));

  IF v_actual <> 0 THEN
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', v_acct_bank,
      'debit', v_actual, 'credit', 0,
      'description', 'Merchant deposit — batch ' || p_settlement_id::text
    ));
  END IF;

  IF v_fee_total <> 0 THEN
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', v_acct_fees,
      'debit', v_fee_total, 'credit', 0,
      'description', 'Acquirer fees — batch ' || p_settlement_id::text
    ));
  END IF;

  v_diff := v_expected - (v_actual + v_fee_total);
  IF v_diff > 0 THEN
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', v_acct_shortover,
      'debit', v_diff, 'credit', 0,
      'description', 'Cash short — batch ' || p_settlement_id::text
    ));
  ELSIF v_diff < 0 THEN
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', v_acct_shortover,
      'debit', 0, 'credit', -v_diff,
      'description', 'Cash over — batch ' || p_settlement_id::text
    ));
  END IF;

  v_entry_number := public.get_next_journal_entry_number(v_row.organization_id);

  v_entry_id := public.post_journal_entry_atomic(
    v_row.organization_id,
    v_row.business_id,
    v_entry_number,
    (COALESCE(v_row.closed_at, now()))::date,
    'CARD-STL-' || substr(p_settlement_id::text, 1, 8),
    'Card settlement ' || v_row.provider_key || ' — batch ' || p_settlement_id::text,
    'pos_card_settlement',
    p_settlement_id,
    v_row.closed_by,
    false,
    false,
    v_lines,
    NULL, NULL, NULL
  );

  INSERT INTO public.pos_card_settlement_gl_apply_log(settlement_id, journal_entry_id, applied_by)
  VALUES (p_settlement_id, v_entry_id, v_row.closed_by)
  ON CONFLICT (settlement_id) DO NOTHING;

  UPDATE public.pos_card_settlements
     SET status = 'reconciled', updated_at = now()
   WHERE id = p_settlement_id AND status = 'closed';

  RETURN jsonb_build_object(
    'settlement_id',    p_settlement_id,
    'journal_entry_id', v_entry_id,
    'status',           'posted'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.pos_card_settlement_post_gl(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pos_card_settlement_post_gl(uuid) TO service_role;
