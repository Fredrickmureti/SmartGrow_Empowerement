
-- 1. Server-side validated JE posting
CREATE OR REPLACE FUNCTION public.post_journal_entry_status(
  _entry_id uuid,
  _user_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _status text;
  _total_debit numeric;
  _total_credit numeric;
BEGIN
  -- Lock the entry row
  SELECT status INTO _status
  FROM journal_entries
  WHERE id = _entry_id
  FOR UPDATE;

  IF _status IS NULL THEN
    RAISE EXCEPTION 'Journal entry not found';
  END IF;

  IF _status <> 'draft' THEN
    RAISE EXCEPTION 'Cannot post a % journal entry. Only draft entries can be posted.', _status;
  END IF;

  -- Validate debit = credit
  SELECT COALESCE(SUM(debit), 0), COALESCE(SUM(credit), 0)
  INTO _total_debit, _total_credit
  FROM journal_entry_lines
  WHERE journal_entry_id = _entry_id;

  IF ABS(_total_debit - _total_credit) > 0.01 THEN
    RAISE EXCEPTION 'Cannot post: debits (%) do not equal credits (%)', _total_debit, _total_credit;
  END IF;

  IF _total_debit = 0 AND _total_credit = 0 THEN
    RAISE EXCEPTION 'Cannot post: journal entry has no lines';
  END IF;

  -- Post
  UPDATE journal_entries
  SET status = 'posted',
      posted_at = now(),
      posted_by = _user_id,
      updated_at = now()
  WHERE id = _entry_id;
END;
$$;

-- 2. Atomic draft JE deletion
CREATE OR REPLACE FUNCTION public.delete_draft_journal_entry(
  _entry_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _status text;
BEGIN
  SELECT status INTO _status
  FROM journal_entries
  WHERE id = _entry_id
  FOR UPDATE;

  IF _status IS NULL THEN
    RAISE EXCEPTION 'Journal entry not found';
  END IF;

  IF _status <> 'draft' THEN
    RAISE EXCEPTION 'Cannot delete a % journal entry. Only draft entries can be deleted.', _status;
  END IF;

  DELETE FROM journal_entry_lines WHERE journal_entry_id = _entry_id;
  DELETE FROM journal_entries WHERE id = _entry_id;
END;
$$;

-- 3. Invoice status counts
CREATE OR REPLACE FUNCTION public.get_invoice_status_counts(
  _org_id uuid,
  _business_id uuid DEFAULT NULL
)
RETURNS TABLE(status text, count bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT i.status::text, COUNT(*)::bigint
  FROM invoices i
  WHERE i.organization_id = _org_id
    AND (_business_id IS NULL OR i.business_id = _business_id)
  GROUP BY i.status;
END;
$$;

-- 4. Bill status counts
CREATE OR REPLACE FUNCTION public.get_bill_status_counts(
  _org_id uuid,
  _business_id uuid DEFAULT NULL
)
RETURNS TABLE(status text, count bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT b.status::text, COUNT(*)::bigint
  FROM bills b
  WHERE b.organization_id = _org_id
    AND (_business_id IS NULL OR b.business_id = _business_id)
  GROUP BY b.status;
END;
$$;
