-- Stage 3 — allow the four newly-enforced reversal action codes in
-- pos_override_matrix. Prior CHECK hardcoded a fixed list; without this,
-- INSERT into pos_override_matrix with the new codes fails.

ALTER TABLE public.pos_override_matrix
  DROP CONSTRAINT IF EXISTS pos_override_matrix_action_chk;

ALTER TABLE public.pos_override_matrix
  ADD CONSTRAINT pos_override_matrix_action_chk CHECK (
    action IN (
      -- pre-existing (Wave 1)
      'void_transaction','void_above_threshold','refund','cross_tender_refund',
      'discount_over_limit','price_change','manual_price','delete_item','no_sale',
      'cash_drop','cash_out_above_threshold','safe_drop','bank_deposit',
      'shift_variance','reopen_shift','force_close_shift','override_age_check',
      -- Stage 3 additions — enforced by RPC
      'pos_card_void',
      'pos_card_reverse',
      'pos_payment_session_reverse_tender'
    )
    OR action LIKE 'pos_return_authorization_transition:%'
  );

COMMENT ON CONSTRAINT pos_override_matrix_action_chk ON public.pos_override_matrix IS
'Whitelist of override-eligible action codes. Return-authorization transitions use the `pos_return_authorization_transition:<to_state>` naming so each transition (approved/rejected/cancelled/etc.) can carry its own threshold row.';
