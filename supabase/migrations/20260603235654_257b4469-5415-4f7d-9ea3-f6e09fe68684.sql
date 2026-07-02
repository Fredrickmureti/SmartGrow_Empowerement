-- 1) Allow new source_type on project ledger tables
ALTER TABLE public.project_cost_entries
  DROP CONSTRAINT IF EXISTS project_cost_entries_source_type_check;
ALTER TABLE public.project_cost_entries
  ADD CONSTRAINT project_cost_entries_source_type_check
  CHECK (source_type = ANY (ARRAY['timesheet','expense','vendor_bill','purchase_order','manual','stock_movement','journal_entry_line']));

ALTER TABLE public.project_revenue_entries
  DROP CONSTRAINT IF EXISTS project_revenue_entries_source_type_check;
ALTER TABLE public.project_revenue_entries
  ADD CONSTRAINT project_revenue_entries_source_type_check
  CHECK (source_type = ANY (ARRAY['invoice','sales_order','milestone','fixed_price','manual','journal_entry_line']));

-- 2) Mirror function
CREATE OR REPLACE FUNCTION public.trg_je_line_to_project_ledger()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_acct_type public.account_type;
  v_je_source_type text;
  v_currency text;
  v_posted_at timestamptz;
  v_project_currency text;
  v_old_project uuid;
  v_new_project uuid;
  v_allowed_je_sources text[] := ARRAY[
    'manual','adjusting','closing','opening_balance','recurring','reversal','journal_entry'
  ];
BEGIN
  -- Resolve old/new project for symmetry
  v_old_project := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN OLD.project_id END;
  v_new_project := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN NEW.project_id END;

  -- Always purge any prior mirrored row for this line first (covers DELETE,
  -- project untag, account swap, amount change).
  DELETE FROM public.project_cost_entries
    WHERE source_type = 'journal_entry_line' AND source_id = COALESCE(NEW.id, OLD.id);
  DELETE FROM public.project_revenue_entries
    WHERE source_type = 'journal_entry_line' AND source_id = COALESCE(NEW.id, OLD.id);

  -- Nothing more to do on DELETE or when the new line has no project tag.
  IF TG_OP = 'DELETE' OR v_new_project IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- Inspect the parent journal entry. Only mirror manual / unsourced entries
  -- so per-source triggers (bills, invoices, POs, timesheets, …) remain the
  -- single writer for document-driven JEs.
  SELECT je.source_type, je.currency, je.posted_at
    INTO v_je_source_type, v_currency, v_posted_at
  FROM public.journal_entries je
  WHERE je.id = NEW.journal_entry_id;

  IF v_je_source_type IS NOT NULL AND NOT (v_je_source_type = ANY (v_allowed_je_sources)) THEN
    RETURN NEW;
  END IF;

  -- Resolve account type
  SELECT a.account_type INTO v_acct_type
  FROM public.accounts a
  WHERE a.id = NEW.account_id;

  IF v_acct_type IS NULL THEN
    RETURN NEW;
  END IF;

  -- Fallback currency: project's base currency, else 'USD'
  IF v_currency IS NULL THEN
    SELECT COALESCE(p.base_currency, 'USD') INTO v_project_currency
    FROM public.projects p WHERE p.id = v_new_project;
    v_currency := COALESCE(v_project_currency, 'USD');
  END IF;

  v_posted_at := COALESCE(v_posted_at, now());

  -- Expense debit → project cost
  IF v_acct_type = 'expense' AND COALESCE(NEW.debit, 0) > 0 THEN
    INSERT INTO public.project_cost_entries (
      organization_id, business_id, project_id,
      source_type, source_id,
      amount, currency, posted_at, description
    ) VALUES (
      NEW.organization_id, NEW.business_id, v_new_project,
      'journal_entry_line', NEW.id,
      NEW.debit, v_currency, v_posted_at,
      COALESCE(NEW.description, 'Journal entry line')
    );

  -- Income credit → project revenue
  ELSIF v_acct_type = 'income' AND COALESCE(NEW.credit, 0) > 0 THEN
    INSERT INTO public.project_revenue_entries (
      organization_id, business_id, project_id,
      source_type, source_id,
      amount, currency, posted_at, description
    ) VALUES (
      NEW.organization_id, NEW.business_id, v_new_project,
      'journal_entry_line', NEW.id,
      NEW.credit, v_currency, v_posted_at,
      COALESCE(NEW.description, 'Journal entry line')
    );
  END IF;

  RETURN NEW;
END;
$$;

-- 3) Wire trigger
DROP TRIGGER IF EXISTS trg_je_line_project_ledger ON public.journal_entry_lines;
CREATE TRIGGER trg_je_line_project_ledger
AFTER INSERT OR UPDATE OF project_id, account_id, debit, credit OR DELETE
ON public.journal_entry_lines
FOR EACH ROW EXECUTE FUNCTION public.trg_je_line_to_project_ledger();

COMMENT ON FUNCTION public.trg_je_line_to_project_ledger() IS
  'Mirrors project-tagged journal entry lines into project_cost_entries / project_revenue_entries. '
  'Skips JEs sourced from documents already handled by per-source triggers (invoice, bill, PO, '
  'timesheet, stock_movement, etc.) to prevent double counting. As per-source triggers are retired, '
  'add their source_type to v_allowed_je_sources so this becomes the single mirror path.';