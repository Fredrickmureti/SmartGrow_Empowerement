-- Atomic bill item replacement: delete all + insert new in a single transaction
CREATE OR REPLACE FUNCTION public.update_bill_items_atomic(
  _bill_id uuid,
  _items jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Delete all existing items for this bill
  DELETE FROM bill_items WHERE bill_id = _bill_id;

  -- Insert new items from JSONB array
  INSERT INTO bill_items (bill_id, account_id, product_id, description, quantity, unit_price, tax_rate, tax_amount, line_total, sort_order)
  SELECT
    _bill_id,
    (item->>'account_id')::uuid,
    (item->>'product_id')::uuid,
    item->>'description',
    (item->>'quantity')::numeric,
    (item->>'unit_price')::numeric,
    COALESCE((item->>'tax_rate')::numeric, 0),
    COALESCE((item->>'tax_amount')::numeric, 0),
    (item->>'line_total')::numeric,
    (item->>'sort_order')::int
  FROM jsonb_array_elements(_items) AS item;
END;
$$;

-- Backfill: recalculate accounts.current_balance from actual JE lines
-- This fixes any drift from before the trigger existed
UPDATE accounts a
SET current_balance = COALESCE(sub.net, 0)
FROM (
  SELECT jel.account_id, SUM(COALESCE(jel.debit, 0) - COALESCE(jel.credit, 0)) AS net
  FROM journal_entry_lines jel
  JOIN journal_entries je ON je.id = jel.journal_entry_id
  GROUP BY jel.account_id
) sub
WHERE a.id = sub.account_id;

-- Also zero out accounts that have no JE lines but had a non-zero current_balance
UPDATE accounts
SET current_balance = 0
WHERE id NOT IN (SELECT DISTINCT account_id FROM journal_entry_lines)
AND current_balance != 0;