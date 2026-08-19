REVOKE ALL ON FUNCTION public._bank_match_closed_window_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._bank_txn_reconcile_closed_window_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._bank_reconciliation_session_freeze() FROM PUBLIC, anon, authenticated;