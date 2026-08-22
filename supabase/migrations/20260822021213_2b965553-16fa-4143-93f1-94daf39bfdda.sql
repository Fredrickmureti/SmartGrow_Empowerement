-- ─────────────────────────────────────────────────────────────
-- Phase 1 — Ledger visibility contract
-- 'posted' and 'reversed' are ledger-visible; 'draft' and 'voided'
-- are not. A reversed entry must remain in the ledger next to its
-- reversal, otherwise the reversal is reported one-sided and every
-- balance is wrong by its amount.
-- ─────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.ledger_visible_journal_statuses()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $$ SELECT ARRAY['posted','reversed']::text[] $$;

COMMENT ON FUNCTION public.ledger_visible_journal_statuses() IS
  'Single source of truth for which journal_entries.status values count toward ledger balances (Ledgers & Journals Phase 1).';

GRANT EXECUTE ON FUNCTION public.ledger_visible_journal_statuses() TO authenticated, anon, service_role;

-- ── get_account_movements ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_account_movements(_org_id uuid, _date_from date, _date_to date, _business_id uuid DEFAULT NULL::uuid, _branch_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(account_id uuid, total_debit numeric, total_credit numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF _org_id IS NULL THEN
    RAISE EXCEPTION 'get_account_movements: _org_id is required';
  END IF;

  IF NOT public.finance_can_read_org(_org_id) THEN
    RAISE EXCEPTION 'Not authorized for this organization' USING ERRCODE = '42501';
  END IF;

  IF _business_id IS NOT NULL THEN
    PERFORM 1 FROM public.businesses b
      WHERE b.id = _business_id AND b.organization_id = _org_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'get_account_movements: business % does not belong to org %', _business_id, _org_id;
    END IF;
  END IF;

  IF _branch_id IS NOT NULL THEN
    PERFORM 1 FROM public.branches br
      WHERE br.id = _branch_id
        AND br.organization_id = _org_id
        AND (_business_id IS NULL OR br.business_id = _business_id);
    IF NOT FOUND THEN
      RAISE EXCEPTION 'get_account_movements: branch % does not belong to org % / business %', _branch_id, _org_id, _business_id;
    END IF;
  END IF;

  RETURN QUERY
  SELECT
    jel.account_id,
    COALESCE(SUM(jel.debit), 0)::numeric  AS total_debit,
    COALESCE(SUM(jel.credit), 0)::numeric AS total_credit
  FROM public.journal_entry_lines jel
  JOIN public.journal_entries je ON je.id = jel.journal_entry_id
  WHERE je.organization_id = _org_id
    AND je.status = ANY (public.ledger_visible_journal_statuses())
    AND je.entry_date BETWEEN _date_from AND _date_to
    AND (_business_id IS NULL OR je.business_id = _business_id)
    AND (_branch_id   IS NULL OR je.branch_id   = _branch_id)
  GROUP BY jel.account_id;
END;
$function$;

-- ── get_general_ledger ───────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_general_ledger(_org_id uuid, _date_from date, _date_to date, _business_id uuid DEFAULT NULL::uuid, _account_ids uuid[] DEFAULT NULL::uuid[], _include_zero_activity boolean DEFAULT false, _branch_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(account_id uuid, account_code text, account_name text, account_type text, opening_balance numeric, line_id uuid, entry_date date, entry_number text, je_description text, line_description text, reference text, debit numeric, credit numeric, source_type text, source_id uuid, contact_name text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF _org_id IS NULL THEN
    RAISE EXCEPTION 'get_general_ledger: _org_id is required';
  END IF;

  IF NOT public.finance_can_read_org(_org_id) THEN
    RAISE EXCEPTION 'Not authorized for this organization' USING ERRCODE = '42501';
  END IF;

  IF _business_id IS NOT NULL THEN
    PERFORM 1 FROM public.businesses b
      WHERE b.id = _business_id AND b.organization_id = _org_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'get_general_ledger: business % does not belong to org %', _business_id, _org_id;
    END IF;
  END IF;

  IF _branch_id IS NOT NULL THEN
    PERFORM 1 FROM public.branches br
      WHERE br.id = _branch_id
        AND br.organization_id = _org_id
        AND (_business_id IS NULL OR br.business_id = _business_id);
    IF NOT FOUND THEN
      RAISE EXCEPTION 'get_general_ledger: branch % does not belong to org % / business %', _branch_id, _org_id, _business_id;
    END IF;
  END IF;

  RETURN QUERY
  WITH scope AS (
    SELECT a.id, a.code, a.name, a.account_type::text AS account_type,
           COALESCE(a.opening_balance, 0) AS opening_balance
    FROM public.accounts a
    WHERE a.organization_id = _org_id
      AND a.is_active = true
      AND (_business_id IS NULL OR a.business_id = _business_id)
      AND (_account_ids IS NULL OR a.id = ANY(_account_ids))
  ),
  prior AS (
    SELECT jel.account_id,
           COALESCE(SUM(jel.debit), 0)  AS prior_debit,
           COALESCE(SUM(jel.credit), 0) AS prior_credit
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id = jel.journal_entry_id
    WHERE je.organization_id = _org_id
      AND je.status = ANY (public.ledger_visible_journal_statuses())
      AND je.entry_date < _date_from
      AND (_business_id IS NULL OR je.business_id = _business_id)
      AND (_branch_id   IS NULL OR je.branch_id   = _branch_id)
    GROUP BY jel.account_id
  ),
  period_lines AS (
    SELECT
      jel.account_id, jel.id AS line_id,
      je.entry_date, je.entry_number,
      je.description AS je_description,
      jel.description AS line_description,
      je.reference,
      COALESCE(jel.debit, 0) AS debit,
      COALESCE(jel.credit, 0) AS credit,
      je.source_type, je.source_id,
      c.name AS contact_name
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id = jel.journal_entry_id
    LEFT JOIN public.contacts c ON c.id = jel.contact_id
    WHERE je.organization_id = _org_id
      AND je.status = ANY (public.ledger_visible_journal_statuses())
      AND je.entry_date BETWEEN _date_from AND _date_to
      AND (_business_id IS NULL OR je.business_id = _business_id)
      AND (_branch_id   IS NULL OR je.branch_id   = _branch_id)
  ),
  scoped AS (
    SELECT
      s.id, s.code, s.name, s.account_type,
      -- Branch-scoped runs must NOT carry the whole account's stored opening
      -- balance: that figure is a business-level property, not a branch one.
      CASE WHEN _branch_id IS NULL THEN s.opening_balance ELSE 0 END
        + CASE
            WHEN s.account_type IN ('asset', 'expense')
              THEN COALESCE(p.prior_debit, 0) - COALESCE(p.prior_credit, 0)
            ELSE COALESCE(p.prior_credit, 0) - COALESCE(p.prior_debit, 0)
          END AS opening_balance_natural,
      pl.line_id, pl.entry_date, pl.entry_number,
      pl.je_description, pl.line_description, pl.reference,
      pl.debit, pl.credit, pl.source_type, pl.source_id, pl.contact_name
    FROM scope s
    LEFT JOIN prior p ON p.account_id = s.id
    LEFT JOIN period_lines pl ON pl.account_id = s.id
  )
  SELECT
    sc.id, sc.code, sc.name, sc.account_type,
    sc.opening_balance_natural,
    sc.line_id, sc.entry_date, sc.entry_number,
    sc.je_description, sc.line_description, sc.reference,
    sc.debit, sc.credit, sc.source_type, sc.source_id, sc.contact_name
  FROM scoped sc
  WHERE _include_zero_activity
     OR sc.line_id IS NOT NULL
     OR sc.opening_balance_natural <> 0
  ORDER BY sc.code, sc.entry_date NULLS FIRST, sc.entry_number NULLS FIRST, sc.line_id NULLS FIRST;
END;
$function$;

-- ── Lineage repair hatch on the immutability trigger ─────────
CREATE OR REPLACE FUNCTION public.enforce_journal_entry_immutability()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  reset_org      TEXT;
  narration_flag TEXT;
  lineage_flag   TEXT;
BEGIN
  reset_org := current_setting('app.reset_in_progress', true);
  IF reset_org IS NOT NULL AND reset_org <> ''
     AND COALESCE(NEW.organization_id, OLD.organization_id)::text = reset_org THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  IF OLD.status NOT IN ('posted', 'voided', 'reversed') THEN
    RETURN NEW;
  END IF;

  -- Lineage repair: only the reversal back-pointer may change, and only
  -- when every other column stays equal. Used to keep
  -- reversed_by_id <-> reversal_of_id consistent.
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

  IF OLD.status IN ('voided', 'reversed') THEN
    RAISE EXCEPTION 'Cannot modify a % journal entry.', OLD.status;
  END IF;

  RAISE EXCEPTION 'Cannot modify a posted journal entry. Create a reversing entry or void it instead.';
END;
$function$;

-- ── One-shot repair of the reversal back-pointer ─────────────
DO $$
BEGIN
  PERFORM set_config('app.je_lineage_repair', 'on', true);

  -- Point every reversed original at the reversal that actually claims it.
  UPDATE public.journal_entries orig
     SET reversed_by_id = rev.id
    FROM public.journal_entries rev
   WHERE rev.reversal_of_id = orig.id
     AND orig.reversed_by_id IS DISTINCT FROM rev.id;

  -- Clear dangling pointers that reference no existing entry.
  UPDATE public.journal_entries orig
     SET reversed_by_id = NULL
   WHERE orig.reversed_by_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.journal_entries r WHERE r.id = orig.reversed_by_id
     );

  PERFORM set_config('app.je_lineage_repair', 'off', true);
END $$;

-- ── Keep the pair consistent from now on ─────────────────────
CREATE OR REPLACE FUNCTION public.sync_journal_reversal_backpointer()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.reversal_of_id IS NOT NULL THEN
    PERFORM set_config('app.je_lineage_repair', 'on', true);
    UPDATE public.journal_entries o
       SET reversed_by_id = NEW.id
     WHERE o.id = NEW.reversal_of_id
       AND o.reversed_by_id IS DISTINCT FROM NEW.id;
    PERFORM set_config('app.je_lineage_repair', 'off', true);
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_sync_journal_reversal_backpointer ON public.journal_entries;
CREATE TRIGGER trg_sync_journal_reversal_backpointer
AFTER INSERT OR UPDATE OF reversal_of_id ON public.journal_entries
FOR EACH ROW EXECUTE FUNCTION public.sync_journal_reversal_backpointer();