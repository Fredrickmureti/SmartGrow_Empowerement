
DROP FUNCTION IF EXISTS public.process_pos_void(
  p_organization_id uuid,
  p_transaction_id uuid,
  p_void_reason_id uuid,
  p_void_note text,
  p_voided_by uuid,
  p_override_id uuid
);
