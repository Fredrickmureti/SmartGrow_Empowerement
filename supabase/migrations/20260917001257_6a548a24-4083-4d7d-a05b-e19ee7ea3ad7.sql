UPDATE public.accounts
SET detail_type = 'unearned_revenue',
    cash_flow_category = COALESCE(cash_flow_category, 'operating'),
    updated_at = now()
WHERE code = '2440'
  AND account_type = 'liability'
  AND detail_type = 'notes_payable';