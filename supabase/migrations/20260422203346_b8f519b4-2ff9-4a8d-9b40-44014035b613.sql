ALTER FUNCTION public.enforce_cashier_register_branch_match() SET search_path TO 'public';
ALTER FUNCTION public.stamp_pos_child_scope_from_txn() SET search_path TO 'public';
ALTER FUNCTION public.stamp_pos_cashier_register_scope() SET search_path TO 'public';
ALTER FUNCTION public.enforce_pos_credit_invoice_lineage() SET search_path TO 'public';