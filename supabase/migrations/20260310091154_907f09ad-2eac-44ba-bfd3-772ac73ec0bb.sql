
-- Add 'reversed' to the allowed status values
ALTER TABLE journal_entries DROP CONSTRAINT journal_entries_status_check;
ALTER TABLE journal_entries ADD CONSTRAINT journal_entries_status_check 
  CHECK (status = ANY (ARRAY['draft'::text, 'posted'::text, 'voided'::text, 'reversed'::text]));

-- Now reverse incorrect credit_application JEs
ALTER TABLE journal_entries DISABLE TRIGGER trg_enforce_journal_entry_immutability;

DO $$
DECLARE
  v_je RECORD;
  v_new_je_id UUID;
  v_new_je_number TEXT;
  v_line RECORD;
  v_retry INT;
BEGIN
  FOR v_je IN
    SELECT je.id, je.organization_id, je.business_id, je.entry_number,
           je.reference, je.description, je.created_by
      FROM journal_entries je
     WHERE je.source_type = 'credit_application'
       AND je.status = 'posted'
  LOOP
    v_retry := 0;
    LOOP
      BEGIN
        v_new_je_number := generate_next_je_number(v_je.organization_id);
        
        INSERT INTO journal_entries (
          organization_id, business_id, entry_number, entry_date,
          reference, description, source_type, source_id, status, created_by
        ) VALUES (
          v_je.organization_id, v_je.business_id, v_new_je_number,
          CURRENT_DATE,
          'REV-' || v_je.entry_number,
          'Reversal: incorrect credit application GL entry (' || v_je.entry_number || '). Credit note AR reduction already posted at issuance.',
          'reversal', v_je.id, 'posted', v_je.created_by
        ) RETURNING id INTO v_new_je_id;
        EXIT;
      EXCEPTION WHEN unique_violation THEN
        v_retry := v_retry + 1;
        IF v_retry >= 10 THEN
          RAISE EXCEPTION 'Could not generate unique JE number for reversal';
        END IF;
      END;
    END LOOP;

    FOR v_line IN
      SELECT account_id, debit, credit, description
        FROM journal_entry_lines
       WHERE journal_entry_id = v_je.id
    LOOP
      INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description)
      VALUES (v_new_je_id, v_line.account_id, v_line.credit, v_line.debit,
              'Reversal: ' || COALESCE(v_line.description, ''));
    END LOOP;

    UPDATE journal_entries SET status = 'reversed' WHERE id = v_je.id;
  END LOOP;
END $$;

ALTER TABLE journal_entries ENABLE TRIGGER trg_enforce_journal_entry_immutability;
