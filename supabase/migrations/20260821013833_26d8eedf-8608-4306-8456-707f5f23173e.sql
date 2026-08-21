REVOKE EXECUTE ON FUNCTION public._assert_can_read_bank_history(uuid, uuid) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public._bank_history_actor(uuid) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public._bank_match_history_row(public.bank_reconciliation_matches) FROM authenticated;