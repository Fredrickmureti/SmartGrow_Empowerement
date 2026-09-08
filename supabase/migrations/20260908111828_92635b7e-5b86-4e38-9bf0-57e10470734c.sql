-- 1. Ledger visibility: a reversed original stays in the books, offset by its reversal
CREATE OR REPLACE FUNCTION public.ledger_visible_journal_statuses()
RETURNS journal_status[]
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $$ SELECT ARRAY['posted','reversed']::journal_status[] $$;

-- 2. Immutability guard: allow posted -> reversed exactly like posted -> void,
--    and treat a reversed entry as immutable thereafter.
CREATE OR REPLACE FUNCTION public.enforce_journal_entry_immutability()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  reset_org      TEXT;
  narration_flag TEXT;
  lineage_flag   TEXT;
  new_j          jsonb;
  old_j          jsonb;
BEGIN
  reset_org := current_setting('app.reset_in_progress', true);
  IF reset_org IS NOT NULL AND reset_org <> ''
     AND COALESCE(NEW.organization_id, OLD.organization_id)::text = reset_org THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  IF OLD.status NOT IN ('posted', 'void', 'reversed') THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    new_j := (to_jsonb(NEW) - 'journal_book_id') - 'updated_at';
    old_j := (to_jsonb(OLD) - 'journal_book_id') - 'updated_at';
    IF new_j = old_j
       AND (OLD.journal_book_id IS NULL
            OR NEW.journal_book_id IS NOT DISTINCT FROM OLD.journal_book_id)
    THEN
      RETURN NEW;
    END IF;
  END IF;

  lineage_flag := current_setting('app.je_lineage_repair', true);
  IF lineage_flag = 'on'
     AND NEW.status         IS NOT DISTINCT FROM OLD.status
     AND NEW.entry_date     IS NOT DISTINCT FROM OLD.entry_date
     AND NEW.entry_number   IS NOT DISTINCT FROM OLD.entry_number
     AND NEW.description    IS NOT DISTINCT FROM OLD.description
     AND NEW.reference      IS NOT DISTINCT FROM OLD.reference
     AND NEW.source_type    IS NOT DISTINCT FROM OLD.source_type
     AND NEW.source_id      IS NOT DISTINCT FROM OLD.source_id
     AND NEW.total_debit    IS NOT DISTINCT FROM OLD.total_debit
     AND NEW.total_credit   IS NOT DISTINCT FROM OLD.total_credit
     AND NEW.organization_id IS NOT DISTINCT FROM OLD.organization_id
     AND NEW.business_id    IS NOT DISTINCT FROM OLD.business_id
     AND NEW.reversal_of_id IS NOT DISTINCT FROM OLD.reversal_of_id
  THEN
    RETURN NEW;
  END IF;

  narration_flag := current_setting('app.je_narration_repair', true);
  IF narration_flag = 'on'
     AND NEW.status         IS NOT DISTINCT FROM OLD.status
     AND NEW.entry_date     IS NOT DISTINCT FROM OLD.entry_date
     AND NEW.entry_number   IS NOT DISTINCT FROM OLD.entry_number
     AND NEW.source_type    IS NOT DISTINCT FROM OLD.source_type
     AND NEW.source_id      IS NOT DISTINCT FROM OLD.source_id
     AND NEW.source_subtype IS NOT DISTINCT FROM OLD.source_subtype
     AND NEW.total_debit    IS NOT DISTINCT FROM OLD.total_debit
     AND NEW.total_credit   IS NOT DISTINCT FROM OLD.total_credit
     AND NEW.organization_id IS NOT DISTINCT FROM OLD.organization_id
     AND NEW.business_id    IS NOT DISTINCT FROM OLD.business_id
     AND NEW.is_adjusting   IS NOT DISTINCT FROM OLD.is_adjusting
     AND NEW.is_closing     IS NOT DISTINCT FROM OLD.is_closing
     AND NEW.is_reversing   IS NOT DISTINCT FROM OLD.is_reversing
     AND NEW.is_reversal    IS NOT DISTINCT FROM OLD.is_reversal
     AND NEW.reversal_of_id IS NOT DISTINCT FROM OLD.reversal_of_id
     AND NEW.reversed_entry_id IS NOT DISTINCT FROM OLD.reversed_entry_id
     AND NEW.posted_at      IS NOT DISTINCT FROM OLD.posted_at
     AND NEW.posted_by      IS NOT DISTINCT FROM OLD.posted_by
  THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'posted' AND NEW.status IN ('void', 'reversed') THEN
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
      RAISE EXCEPTION 'Cannot modify core fields of a posted journal entry. Only voiding bookkeeping fields are allowed.';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status IN ('void', 'reversed') THEN
    RAISE EXCEPTION 'Cannot modify a % journal entry.', OLD.status;
  END IF;

  RAISE EXCEPTION 'Cannot modify a posted journal entry. Create a reversing entry or void it instead.';
END;
$function$;

-- 3. Lines of a reversed entry are immutable too
CREATE OR REPLACE FUNCTION public.enforce_journal_entry_lines_immutability()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  parent_status TEXT;
  parent_org_id UUID;
  reset_org TEXT;
BEGIN
  reset_org := current_setting('app.reset_in_progress', true);

  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT status, organization_id INTO parent_status, parent_org_id
    FROM public.journal_entries
    WHERE id = OLD.journal_entry_id;

    IF reset_org IS NOT NULL AND reset_org <> '' AND parent_org_id::text = reset_org THEN
      IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
    END IF;

    IF parent_status IN ('posted', 'void', 'reversed') THEN
      RAISE EXCEPTION 'Cannot modify lines of a % journal entry.', parent_status;
    END IF;
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT status, organization_id INTO parent_status, parent_org_id
    FROM public.journal_entries
    WHERE id = NEW.journal_entry_id;

    IF reset_org IS NOT NULL AND reset_org <> '' AND parent_org_id::text = reset_org THEN
      RETURN NEW;
    END IF;

    IF parent_status IN ('posted', 'void', 'reversed') THEN
      IF TG_OP = 'INSERT' AND parent_status = 'posted' THEN
        DECLARE
          parent_created_at TIMESTAMPTZ;
        BEGIN
          SELECT created_at INTO parent_created_at
          FROM public.journal_entries
          WHERE id = NEW.journal_entry_id;

          IF parent_created_at > NOW() - INTERVAL '30 seconds' THEN
            RETURN NEW;
          END IF;
        END;
      END IF;

      RAISE EXCEPTION 'Cannot modify lines of a % journal entry.', parent_status;
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$;

-- 4. Stored account balances must follow ledger-visible entries
CREATE OR REPLACE FUNCTION public.update_account_balance_on_je_line()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _account_type text;
  _je_status text;
  _je_org_id uuid;
  _debit numeric;
  _credit numeric;
  reset_org text;
BEGIN
  SELECT status, organization_id INTO _je_status, _je_org_id
  FROM public.journal_entries
  WHERE id = COALESCE(NEW.journal_entry_id, OLD.journal_entry_id);

  reset_org := current_setting('app.reset_in_progress', true);
  IF reset_org IS NOT NULL AND reset_org <> '' AND _je_org_id::text = reset_org THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF _je_status IS NULL OR _je_status NOT IN ('posted', 'reversed') THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  SELECT account_type::text INTO _account_type
  FROM public.accounts
  WHERE id = COALESCE(NEW.account_id, OLD.account_id);

  IF TG_OP = 'INSERT' THEN
    _debit := COALESCE(NEW.debit, 0);
    _credit := COALESCE(NEW.credit, 0);
    UPDATE public.accounts
    SET current_balance = current_balance +
      CASE WHEN _account_type IN ('asset', 'expense')
        THEN _debit - _credit ELSE _credit - _debit END,
      updated_at = now()
    WHERE id = NEW.account_id;
    RETURN NEW;

  ELSIF TG_OP = 'DELETE' THEN
    _debit := COALESCE(OLD.debit, 0);
    _credit := COALESCE(OLD.credit, 0);
    UPDATE public.accounts
    SET current_balance = current_balance -
      CASE WHEN _account_type IN ('asset', 'expense')
        THEN _debit - _credit ELSE _credit - _debit END,
      updated_at = now()
    WHERE id = OLD.account_id;
    RETURN OLD;

  ELSIF TG_OP = 'UPDATE' THEN
    _debit := COALESCE(OLD.debit, 0);
    _credit := COALESCE(OLD.credit, 0);
    UPDATE public.accounts
    SET current_balance = current_balance -
      CASE WHEN _account_type IN ('asset', 'expense')
        THEN _debit - _credit ELSE _credit - _debit END
    WHERE id = OLD.account_id;

    _debit := COALESCE(NEW.debit, 0);
    _credit := COALESCE(NEW.credit, 0);
    SELECT account_type::text INTO _account_type
    FROM public.accounts WHERE id = NEW.account_id;
    UPDATE public.accounts
    SET current_balance = current_balance +
      CASE WHEN _account_type IN ('asset', 'expense')
        THEN _debit - _credit ELSE _credit - _debit END,
      updated_at = now()
    WHERE id = NEW.account_id;
    RETURN NEW;
  END IF;

  RETURN NULL;
END;
$function$;

-- 5. Balance integrity check must compare against ledger-visible entries
CREATE OR REPLACE FUNCTION public.check_balance_integrity(_org_id uuid, _business_id uuid DEFAULT NULL::uuid)
RETURNS TABLE(account_id uuid, business_id uuid, account_code text, account_name text, stored_balance numeric, ledger_balance numeric, drift numeric)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.finance_can_read_org(_org_id) THEN
    RAISE EXCEPTION 'Not authorized for this organization' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH ledger AS (
    SELECT jel.account_id,
      je.business_id,
      SUM(CASE WHEN acct.account_type IN ('asset','expense')
        THEN COALESCE(jel.debit,0) - COALESCE(jel.credit,0)
        ELSE COALESCE(jel.credit,0) - COALESCE(jel.debit,0)
      END) AS balance
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id = jel.journal_entry_id
    JOIN public.accounts acct ON acct.id = jel.account_id
    WHERE je.organization_id = _org_id
      AND je.status = ANY (public.ledger_visible_journal_statuses())
      AND (_business_id IS NULL OR je.business_id = _business_id)
    GROUP BY jel.account_id, je.business_id
  )
  SELECT a.id AS account_id,
         a.business_id,
         a.code AS account_code,
         a.name AS account_name,
         COALESCE(a.current_balance, 0) AS stored_balance,
         COALESCE(l.balance, 0) AS ledger_balance,
         COALESCE(a.current_balance, 0) - COALESCE(l.balance, 0) AS drift
  FROM public.accounts a
  LEFT JOIN ledger l
    ON l.account_id = a.id
   AND l.business_id = a.business_id
  WHERE a.organization_id = _org_id
    AND (_business_id IS NULL OR a.business_id = _business_id)
    AND ABS(COALESCE(a.current_balance, 0) - COALESCE(l.balance, 0)) > 0.001;
END;
$function$;

-- 6. Reversal now marks the original "reversed", not "void"
CREATE OR REPLACE FUNCTION public.void_journal_entry_atomic(_entry_id uuid, _reason text, _user_id uuid DEFAULT NULL::uuid, _entry_number text DEFAULT NULL::text, _reversal_date date DEFAULT NULL::date)
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
  _reversal_subtype text;
  _tot_debit numeric;
  _tot_credit numeric;
  _prev_suppress text;
BEGIN
  SELECT * INTO _original FROM journal_entries WHERE id = _entry_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Journal entry not found: %', _entry_id;
  END IF;

  IF _original.status IN ('void','reversed') AND _original.reversed_by_id IS NOT NULL THEN
    RETURN _original.reversed_by_id;
  END IF;

  IF _original.status IN ('void','reversed') THEN
    RAISE EXCEPTION 'This journal entry has already been reversed.';
  END IF;
  IF _original.status <> 'posted' THEN
    RAISE EXCEPTION 'Cannot void a % journal entry.', _original.status;
  END IF;
  IF _original.is_reversal = true OR _original.reversal_of_id IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot void a reversal journal entry.';
  END IF;

  _reversal_subtype := CASE
    WHEN _original.source_subtype IS NULL OR _original.source_subtype = '' THEN 'reversal'
    ELSE 'reversal:' || _original.source_subtype
  END;

  IF _original.source_type IS NOT NULL AND _original.source_id IS NOT NULL THEN
    SELECT id INTO _existing_reversal
    FROM journal_entries
    WHERE organization_id = _original.organization_id
      AND source_type = _original.source_type
      AND source_id = _original.source_id
      AND source_subtype = _reversal_subtype
      AND status <> 'void'
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

  IF _entry_number IS NULL THEN
    SELECT COALESCE(
      'JE-' || LPAD((COALESCE(MAX(NULLIF(regexp_replace(entry_number, '[^0-9]', '', 'g'), ''))::int, 0) + 1)::text, 5, '0'),
      'JE-00001'
    ) INTO _final_entry_number
    FROM journal_entries WHERE organization_id = _org_id;
  ELSE
    _final_entry_number := _entry_number;
  END IF;

  SELECT COALESCE(SUM(COALESCE(credit, 0)), 0), COALESCE(SUM(COALESCE(debit, 0)), 0)
    INTO _tot_debit, _tot_credit
  FROM journal_entry_lines WHERE journal_entry_id = _entry_id;

  INSERT INTO journal_entries (
    id, organization_id, business_id, branch_id, journal_book_id,
    entry_number, entry_date,
    description, reference, status, posted_at, posted_by, created_by,
    source_type, source_id, source_subtype,
    is_reversal, is_reversing, reversal_of_id,
    total_debit, total_credit,
    void_reason, created_at, updated_at
  ) VALUES (
    _reversal_id, _org_id, _business_id, _original.branch_id, _original.journal_book_id,
    _final_entry_number,
    _final_reversal_date,
    'Reversal of ' || _original.entry_number || ': ' || _reason,
    _original.reference,
    'posted', _now, _user_id, _user_id,
    COALESCE(_original.source_type, 'void'),
    COALESCE(_original.source_id, _entry_id),
    _reversal_subtype,
    true, true, _entry_id,
    _tot_debit, _tot_credit,
    _reason, _now, _now
  );

  _prev_suppress := COALESCE(current_setting('app.suppress_je_recompute', true), '');
  PERFORM set_config('app.suppress_je_recompute', 'on', true);

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

  PERFORM set_config('app.suppress_je_recompute', _prev_suppress, true);

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

-- 7. Backfill: originals that carry a reversal were marked void; they belong in
--    the books as "reversed". Triggers are suspended for this repair only.
ALTER TABLE public.journal_entries DISABLE TRIGGER USER;

UPDATE public.journal_entries o
   SET status = 'reversed', updated_at = now()
 WHERE o.status = 'void'
   AND o.reversed_by_id IS NOT NULL
   AND EXISTS (SELECT 1 FROM public.journal_entries r
                WHERE r.id = o.reversed_by_id AND r.status = 'posted');

ALTER TABLE public.journal_entries ENABLE TRIGGER USER;

-- 8. Recompute stored account balances from ledger-visible entries
UPDATE public.accounts a
   SET current_balance = COALESCE(l.balance, 0),
       updated_at = now()
  FROM (
    SELECT acc.id AS account_id,
           SUM(CASE WHEN acc.account_type IN ('asset','expense')
                    THEN COALESCE(jel.debit,0) - COALESCE(jel.credit,0)
                    ELSE COALESCE(jel.credit,0) - COALESCE(jel.debit,0) END) AS balance
      FROM public.accounts acc
      JOIN public.journal_entry_lines jel ON jel.account_id = acc.id
      JOIN public.journal_entries je ON je.id = jel.journal_entry_id
                                    AND je.business_id = acc.business_id
     WHERE je.status IN ('posted','reversed')
     GROUP BY acc.id
  ) l
 WHERE a.id = l.account_id
   AND COALESCE(a.current_balance,0) <> COALESCE(l.balance,0);

-- Rollback (manual): ALTER TABLE public.journal_entries DISABLE TRIGGER USER;
--   UPDATE public.journal_entries SET status='void' WHERE status='reversed';
--   ALTER TABLE public.journal_entries ENABLE TRIGGER USER;
--   plus restore the previous function bodies.
