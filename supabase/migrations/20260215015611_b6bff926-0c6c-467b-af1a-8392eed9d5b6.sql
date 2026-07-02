
-- =====================================================
-- C3: Atomic journal entry number generation via sequence
-- =====================================================

-- Create a function to get the next journal entry number atomically
CREATE OR REPLACE FUNCTION public.get_next_journal_entry_number(_org_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    next_num INTEGER;
    year_prefix TEXT;
BEGIN
    year_prefix := to_char(CURRENT_DATE, 'YYYY');
    
    -- Use FOR UPDATE to lock the rows during number generation
    SELECT COALESCE(MAX(
        CAST(NULLIF(regexp_replace(entry_number, '[^0-9]', '', 'g'), '') AS INTEGER)
    ), 0) + 1
    INTO next_num
    FROM public.journal_entries
    WHERE organization_id = _org_id
    AND entry_number LIKE 'JE-' || year_prefix || '-%'
    FOR UPDATE;
    
    RETURN 'JE-' || year_prefix || '-' || LPAD(next_num::TEXT, 5, '0');
END;
$$;

-- Also make invoice and bill number functions use FOR UPDATE for atomicity
CREATE OR REPLACE FUNCTION public.get_next_invoice_number(_org_id uuid)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    next_num INTEGER;
    year_prefix TEXT;
BEGIN
    year_prefix := to_char(CURRENT_DATE, 'YYYY');
    
    SELECT COALESCE(MAX(
        CAST(NULLIF(regexp_replace(invoice_number, '[^0-9]', '', 'g'), '') AS INTEGER)
    ), 0) + 1
    INTO next_num
    FROM public.invoices
    WHERE organization_id = _org_id
    AND invoice_number LIKE 'INV-' || year_prefix || '-%'
    FOR UPDATE;
    
    RETURN 'INV-' || year_prefix || '-' || LPAD(next_num::TEXT, 4, '0');
END;
$$;

CREATE OR REPLACE FUNCTION public.get_next_bill_number(_org_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    next_num INTEGER;
    year_prefix TEXT;
    prefix TEXT;
BEGIN
    year_prefix := to_char(CURRENT_DATE, 'YYYY');
    
    SELECT COALESCE(bill_prefix, 'BILL') INTO prefix
    FROM public.organizations WHERE id = _org_id;
    
    SELECT COALESCE(MAX(
        CAST(NULLIF(regexp_replace(bill_number, '[^0-9]', '', 'g'), '') AS INTEGER)
    ), 0) + 1
    INTO next_num
    FROM public.bills
    WHERE organization_id = _org_id
    AND bill_number LIKE prefix || '-' || year_prefix || '-%'
    FOR UPDATE;
    
    RETURN prefix || '-' || year_prefix || '-' || LPAD(next_num::TEXT, 4, '0');
END;
$$;

-- =====================================================
-- C4: Auto-update account balances on GL posting
-- =====================================================

-- Trigger function to update account current_balance when journal entry lines are inserted
CREATE OR REPLACE FUNCTION public.update_account_balance_on_je_line()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    je_status TEXT;
BEGIN
    -- Only update balances for posted journal entries
    SELECT status INTO je_status
    FROM public.journal_entries
    WHERE id = COALESCE(NEW.journal_entry_id, OLD.journal_entry_id);

    IF je_status = 'posted' THEN
        IF TG_OP = 'INSERT' THEN
            UPDATE public.accounts
            SET current_balance = COALESCE(current_balance, 0) + COALESCE(NEW.debit, 0) - COALESCE(NEW.credit, 0),
                updated_at = now()
            WHERE id = NEW.account_id;
        ELSIF TG_OP = 'DELETE' THEN
            UPDATE public.accounts
            SET current_balance = COALESCE(current_balance, 0) - COALESCE(OLD.debit, 0) + COALESCE(OLD.credit, 0),
                updated_at = now()
            WHERE id = OLD.account_id;
        END IF;
    END IF;

    RETURN COALESCE(NEW, OLD);
END;
$$;

-- Create trigger on journal_entry_lines
DROP TRIGGER IF EXISTS trg_update_account_balance_on_je_line ON public.journal_entry_lines;
CREATE TRIGGER trg_update_account_balance_on_je_line
    AFTER INSERT OR DELETE ON public.journal_entry_lines
    FOR EACH ROW
    EXECUTE FUNCTION public.update_account_balance_on_je_line();

-- Also update balances when a journal entry status changes to 'posted' (for entries with existing lines)
CREATE OR REPLACE FUNCTION public.update_account_balances_on_je_post()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    -- When status changes to 'posted', apply all lines to account balances
    IF NEW.status = 'posted' AND (OLD.status IS NULL OR OLD.status != 'posted') THEN
        UPDATE public.accounts a
        SET current_balance = COALESCE(a.current_balance, 0) + sub.net_change,
            updated_at = now()
        FROM (
            SELECT account_id, SUM(COALESCE(debit, 0) - COALESCE(credit, 0)) AS net_change
            FROM public.journal_entry_lines
            WHERE journal_entry_id = NEW.id
            GROUP BY account_id
        ) sub
        WHERE a.id = sub.account_id;
    END IF;

    -- When status changes to 'voided' from 'posted', reverse all lines
    IF NEW.status = 'voided' AND OLD.status = 'posted' THEN
        UPDATE public.accounts a
        SET current_balance = COALESCE(a.current_balance, 0) - sub.net_change,
            updated_at = now()
        FROM (
            SELECT account_id, SUM(COALESCE(debit, 0) - COALESCE(credit, 0)) AS net_change
            FROM public.journal_entry_lines
            WHERE journal_entry_id = NEW.id
            GROUP BY account_id
        ) sub
        WHERE a.id = sub.account_id;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_update_account_balances_on_je_post ON public.journal_entries;
CREATE TRIGGER trg_update_account_balances_on_je_post
    AFTER UPDATE ON public.journal_entries
    FOR EACH ROW
    WHEN (OLD.status IS DISTINCT FROM NEW.status)
    EXECUTE FUNCTION public.update_account_balances_on_je_post();

-- C2: Enforce fiscal period locks at database level
-- Prevent inserts into journal_entry_lines for entries dated in closed fiscal periods
CREATE OR REPLACE FUNCTION public.enforce_fiscal_period_lock()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    entry_date DATE;
    entry_org_id UUID;
    entry_biz_id UUID;
    locked_period RECORD;
BEGIN
    -- Get the journal entry date and org
    SELECT je.entry_date, je.organization_id, je.business_id
    INTO entry_date, entry_org_id, entry_biz_id
    FROM public.journal_entries je
    WHERE je.id = NEW.journal_entry_id;

    -- Check if date falls in a closed fiscal period
    SELECT fp.id, fp.name INTO locked_period
    FROM public.fiscal_periods fp
    WHERE fp.organization_id = entry_org_id
    AND fp.status = 'closed'
    AND entry_date BETWEEN fp.start_date AND fp.end_date
    AND (fp.business_id = entry_biz_id OR fp.business_id IS NULL)
    LIMIT 1;

    IF FOUND THEN
        RAISE EXCEPTION 'Cannot post to closed fiscal period: %', locked_period.name;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_fiscal_period_lock ON public.journal_entry_lines;
CREATE TRIGGER trg_enforce_fiscal_period_lock
    BEFORE INSERT ON public.journal_entry_lines
    FOR EACH ROW
    EXECUTE FUNCTION public.enforce_fiscal_period_lock();
