
DO $$
DECLARE
  _org_id uuid := '0a1691f2-1d76-430d-809c-68955e560ec7';
  _user_id uuid := '4cf18944-4250-4199-af49-94bf32541fa7';
  _ap_id uuid := '00eb9a97-eaff-4951-b5ed-0dc5c54ff29e';
  _cogs_id uuid := 'daa837a3-953a-4f8f-a99e-cb67c8e8d357';
  _redundant_id uuid;
  _now timestamptz := now();
BEGIN
  -- Find the redundant reversing entry (JE-00005) we created moments ago
  SELECT id INTO _redundant_id
  FROM journal_entries
  WHERE organization_id = _org_id
    AND entry_number = 'JE-00005'
    AND is_reversal = true
  LIMIT 1;

  IF _redundant_id IS NULL THEN
    RAISE EXCEPTION 'Could not locate the redundant reversing entry to void';
  END IF;

  -- Void it (voiding alone is sufficient — get_account_balances filters voided)
  UPDATE journal_entries
  SET status = 'voided',
      voided_at = _now,
      voided_by = _user_id,
      void_reason = 'Redundant: voiding JE-00003 alone was sufficient to remove the duplicate posting',
      updated_at = _now
  WHERE id = _redundant_id;

  -- Restore the cached current_balance adjustments we made earlier
  -- We had subtracted 5000 from each. Add it back.
  UPDATE accounts SET current_balance = COALESCE(current_balance,0) + 5000, updated_at = _now WHERE id = _ap_id;
  UPDATE accounts SET current_balance = COALESCE(current_balance,0) + 5000, updated_at = _now WHERE id = _cogs_id;
END $$;
