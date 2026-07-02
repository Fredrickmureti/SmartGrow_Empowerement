-- ============================================================================
-- M-3: Drop the legacy 4-arg void overload — keep only canonical 5-arg version
-- ============================================================================
DROP FUNCTION IF EXISTS public.void_journal_entry_atomic(uuid, text, uuid, text);

-- ============================================================================
-- M-4: Rewrite void_journal_entry_atomic so it does NOT manually update
--      accounts.current_balance. Instead, it relies on:
--        - trg_update_account_balance_on_je_line (AFTER INSERT on lines, when
--          the parent JE is 'posted') for the reversal lines, AND
--        - trg_sync_balances_on_je_status (AFTER UPDATE on JE status) for the
--          original entry going posted → reversed.
--      This eliminates the 2x double-count bug.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.void_journal_entry_atomic(
  _entry_id uuid,
  _reason text,
  _user_id uuid DEFAULT NULL,
  _entry_number text DEFAULT NULL,
  _reversal_date date DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _original RECORD;
  _reversal_id uuid := gen_random_uuid();
  _line RECORD;
  _now timestamptz := now();
  _org_id uuid;
  _business_id uuid;
  _final_entry_number text;
  _final_reversal_date date;
  _existing_reversal uuid;
BEGIN
  -- 1. Fetch and lock the original entry
  SELECT * INTO _original FROM journal_entries WHERE id = _entry_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Journal entry not found: %', _entry_id;
  END IF;

  -- 2. Idempotency: if already reversed, return the existing reversal id
  IF _original.status = 'reversed' AND _original.reversed_by_id IS NOT NULL THEN
    RETURN _original.reversed_by_id;
  END IF;

  -- 3. Guard checks
  IF _original.status = 'voided' THEN
    RAISE EXCEPTION 'This journal entry has already been voided.';
  END IF;
  IF _original.status <> 'posted' THEN
    RAISE EXCEPTION 'Cannot void a % journal entry.', _original.status;
  END IF;
  IF _original.is_reversal = true OR _original.reversal_of_id IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot void a reversal journal entry.';
  END IF;

  -- 4. Idempotency at the source-linkage layer
  IF _original.source_type IS NOT NULL AND _original.source_id IS NOT NULL THEN
    SELECT id INTO _existing_reversal
    FROM journal_entries
    WHERE organization_id = _original.organization_id
      AND source_type = _original.source_type
      AND source_id = _original.source_id
      AND COALESCE(source_subtype, '') = 'reversal'
      AND status <> 'voided'
    LIMIT 1;
    IF _existing_reversal IS NOT NULL THEN
      UPDATE journal_entries
      SET status = 'reversed', reversed_by_id = _existing_reversal, updated_at = _now
      WHERE id = _entry_id AND status = 'posted';
      RETURN _existing_reversal;
    END IF;
  END IF;

  _org_id := _original.organization_id;
  _business_id := _original.business_id;
  _final_reversal_date := COALESCE(_reversal_date, CURRENT_DATE);

  -- 5. Generate entry number
  IF _entry_number IS NULL THEN
    SELECT COALESCE(
      'JE-' || LPAD((COALESCE(MAX(NULLIF(regexp_replace(entry_number, '[^0-9]', '', 'g'), ''))::int, 0) + 1)::text, 5, '0'),
      'JE-00001'
    ) INTO _final_entry_number
    FROM journal_entries WHERE organization_id = _org_id;
  ELSE
    _final_entry_number := _entry_number;
  END IF;

  -- 6. Insert reversal JE header (status='posted' so line trigger applies balance)
  INSERT INTO journal_entries (
    id, organization_id, business_id, entry_number, entry_date,
    description, reference, status, posted_at, posted_by, created_by,
    source_type, source_id, source_subtype,
    is_reversal, is_reversing, reversal_of_id,
    void_reason, created_at, updated_at
  ) VALUES (
    _reversal_id, _org_id, _business_id, _final_entry_number,
    _final_reversal_date,
    'Reversal of ' || _original.entry_number || ': ' || _reason,
    _original.reference,
    'posted', _now, _user_id, _user_id,
    COALESCE(_original.source_type, 'void'),
    COALESCE(_original.source_id, _entry_id),
    'reversal',
    true, true, _entry_id,
    _reason, _now, _now
  );

  -- 7. Flip dr/cr and INSERT lines.
  --    The AFTER-INSERT line trigger (trg_update_account_balance_on_je_line)
  --    will apply the reversal effect to accounts.current_balance.
  --    DO NOT manually update accounts here — that caused the 2x bug.
  FOR _line IN
    SELECT * FROM journal_entry_lines WHERE journal_entry_id = _entry_id ORDER BY sort_order
  LOOP
    INSERT INTO journal_entry_lines (
      journal_entry_id, account_id, description, debit, credit, contact_id, sort_order, created_at
    ) VALUES (
      _reversal_id, _line.account_id,
      'REVERSAL: ' || COALESCE(_line.description, ''),
      COALESCE(_line.credit, 0),
      COALESCE(_line.debit, 0),
      _line.contact_id, _line.sort_order, _now
    );
  END LOOP;

  -- 8. Mark original entry as reversed.
  --    sync_balances_on_je_status_change handles draft→posted and posted→voided
  --    but NOT posted→reversed today; the reversal lines above already produced
  --    the offsetting balance via the line trigger, so the original lines must
  --    REMAIN counted (we do NOT want a second reversal here).
  --    Therefore the status change to 'reversed' must be a no-op for balances.
  UPDATE journal_entries
  SET status = 'reversed',
      reversed_by_id = _reversal_id,
      voided_at = _now,
      voided_by = _user_id,
      void_reason = _reason,
      updated_at = _now
  WHERE id = _entry_id;

  RETURN _reversal_id;
END;
$function$;

-- ============================================================================
-- M-4 (cont.): sync_balances_on_je_status_change — make sure 'reversed' is
-- correctly handled (no-op so we don't double-count; the reversal lines posted
-- in step 7 above already carry the offset).
-- Also handle a future 'reversed → posted' restoration symmetrically.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.sync_balances_on_je_status_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  -- posted → voided: subtract all line impacts (entry never produces effect again)
  IF OLD.status = 'posted' AND NEW.status = 'voided' THEN
    UPDATE accounts a
    SET current_balance = a.current_balance - (
      CASE WHEN a.account_type IN ('asset', 'expense')
        THEN COALESCE(jel.debit, 0) - COALESCE(jel.credit, 0)
        ELSE COALESCE(jel.credit, 0) - COALESCE(jel.debit, 0)
      END
    ),
    updated_at = now()
    FROM journal_entry_lines jel
    WHERE jel.journal_entry_id = NEW.id
      AND a.id = jel.account_id;
  END IF;

  -- draft → posted: apply all line balances (lines were inserted while draft,
  -- so the line-INSERT trigger skipped them — apply them now).
  IF OLD.status = 'draft' AND NEW.status = 'posted' THEN
    UPDATE accounts a
    SET current_balance = a.current_balance + (
      CASE WHEN a.account_type IN ('asset', 'expense')
        THEN COALESCE(jel.debit, 0) - COALESCE(jel.credit, 0)
        ELSE COALESCE(jel.credit, 0) - COALESCE(jel.debit, 0)
      END
    ),
    updated_at = now()
    FROM journal_entry_lines jel
    WHERE jel.journal_entry_id = NEW.id
      AND a.id = jel.account_id;
  END IF;

  -- posted → reversed: NO-OP. The reversal sub-entry's posted lines already
  -- produced an offsetting balance via the line trigger. Touching balances
  -- here would double-count.

  RETURN NEW;
END;
$function$;

-- ============================================================================
-- M-6: Tighten enforce_journal_entry_immutability — explicitly allow ONLY the
-- reversal-bookkeeping fields to change on a posted entry (status to voided
-- OR reversed, plus the link/linkage columns + voided_at/by/reason).
-- All other field mutations are blocked, including is_reversal/is_reversing
-- which earlier escaped the allowlist.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.enforce_journal_entry_immutability()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  -- Only enforce on posted/voided/reversed entries
  IF OLD.status NOT IN ('posted', 'voided', 'reversed') THEN
    RETURN NEW;
  END IF;

  -- Allow posted → voided OR posted → reversed transition with a strict allowlist
  IF OLD.status = 'posted' AND NEW.status IN ('voided', 'reversed') THEN
    IF NEW.entry_date IS DISTINCT FROM OLD.entry_date
       OR NEW.description IS DISTINCT FROM OLD.description
       OR NEW.reference IS DISTINCT FROM OLD.reference
       OR NEW.entry_number IS DISTINCT FROM OLD.entry_number
       OR NEW.source_type IS DISTINCT FROM OLD.source_type
       OR NEW.source_id IS DISTINCT FROM OLD.source_id
       OR NEW.source_subtype IS DISTINCT FROM OLD.source_subtype
       OR NEW.is_adjusting IS DISTINCT FROM OLD.is_adjusting
       OR NEW.is_closing IS DISTINCT FROM OLD.is_closing
       OR NEW.is_reversing IS DISTINCT FROM OLD.is_reversing
       OR NEW.is_reversal IS DISTINCT FROM OLD.is_reversal
       OR NEW.reversal_of_id IS DISTINCT FROM OLD.reversal_of_id
       OR NEW.reversed_entry_id IS DISTINCT FROM OLD.reversed_entry_id
       OR NEW.posted_at IS DISTINCT FROM OLD.posted_at
       OR NEW.posted_by IS DISTINCT FROM OLD.posted_by
       OR NEW.total_debit IS DISTINCT FROM OLD.total_debit
       OR NEW.total_credit IS DISTINCT FROM OLD.total_credit
       OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
       OR NEW.business_id IS DISTINCT FROM OLD.business_id
    THEN
      RAISE EXCEPTION 'Cannot modify core fields of a posted journal entry. Only voiding/reversing bookkeeping fields are allowed.';
    END IF;
    RETURN NEW;
  END IF;

  -- Voided/reversed entries cannot be changed at all
  IF OLD.status IN ('voided', 'reversed') THEN
    RAISE EXCEPTION 'Cannot modify a % journal entry.', OLD.status;
  END IF;

  -- Posted → posted with field changes is forbidden
  RAISE EXCEPTION 'Cannot modify a posted journal entry. Create a reversing entry or void it instead.';
END;
$function$;