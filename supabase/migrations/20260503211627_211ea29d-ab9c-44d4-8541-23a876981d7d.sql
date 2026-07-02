-- Phase 4: Customer Credits — branch safety
ALTER TABLE public.credit_note_applications
  ADD COLUMN IF NOT EXISTS business_id uuid,
  ADD COLUMN IF NOT EXISTS branch_id uuid;

UPDATE public.credit_note_applications cna
   SET business_id = cn.business_id,
       branch_id   = cn.branch_id
  FROM public.credit_notes cn
 WHERE cna.credit_note_id = cn.id
   AND (cna.business_id IS DISTINCT FROM cn.business_id
        OR cna.branch_id IS DISTINCT FROM cn.branch_id);

CREATE INDEX IF NOT EXISTS idx_cna_business_branch
  ON public.credit_note_applications (business_id, branch_id);

DROP POLICY IF EXISTS "Users can view credit applications" ON public.credit_note_applications;
DROP POLICY IF EXISTS "Users can create credit applications" ON public.credit_note_applications;
DROP POLICY IF EXISTS "View credit applications (branch-aware)" ON public.credit_note_applications;
DROP POLICY IF EXISTS "Create credit applications (branch-aware)" ON public.credit_note_applications;

CREATE POLICY "View credit applications (branch-aware)"
  ON public.credit_note_applications
  FOR SELECT
  USING (
    credit_note_id IN (
      SELECT id FROM public.credit_notes
       WHERE organization_id IN (SELECT get_user_organizations(auth.uid()))
    )
    AND (
      branch_id IS NULL
      OR public.user_can_access_branch(auth.uid(), branch_id)
      OR public.has_finance_permission(auth.uid(), 'finance.view_consolidated', business_id)
    )
  );

CREATE POLICY "Create credit applications (branch-aware)"
  ON public.credit_note_applications
  FOR INSERT
  WITH CHECK (
    credit_note_id IN (
      SELECT id FROM public.credit_notes
       WHERE organization_id IN (SELECT get_user_organizations(auth.uid()))
    )
    AND (
      branch_id IS NULL
      OR public.user_can_access_branch(auth.uid(), branch_id)
    )
  );

DROP FUNCTION IF EXISTS public.apply_credit_to_invoice_atomic(
  uuid, uuid, uuid, uuid, numeric, uuid, text, uuid, uuid
);

CREATE OR REPLACE FUNCTION public.apply_credit_to_invoice_atomic(
  _org_id uuid,
  _business_id uuid,
  _credit_note_id uuid,
  _invoice_id uuid,
  _amount numeric,
  _applied_by uuid,
  _notes text DEFAULT NULL,
  _customer_deposits_account_id uuid DEFAULT NULL,
  _receivable_account_id uuid DEFAULT NULL,
  _branch_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_credit_note RECORD;
  v_invoice RECORD;
  v_available_credit NUMERIC;
  v_invoice_balance NUMERIC;
  v_application_id UUID;
  v_je_id UUID;
  v_je_number TEXT;
  v_new_cn_applied NUMERIC;
  v_new_cn_status TEXT;
  v_new_inv_paid NUMERIC;
  v_new_inv_status TEXT;
  v_target_branch UUID;
  v_retry INT := 0;
  v_max_retries INT := 5;
BEGIN
  IF _amount <= 0 THEN
    RAISE EXCEPTION 'Application amount must be positive';
  END IF;

  SELECT id, credit_note_number, total, amount_applied, status, contact_id,
         business_id, branch_id
    INTO v_credit_note
    FROM credit_notes
   WHERE id = _credit_note_id
     AND organization_id = _org_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Credit note not found';
  END IF;

  IF v_credit_note.status NOT IN ('issued') THEN
    RAISE EXCEPTION 'Credit note is not in issued status (current: %)', v_credit_note.status;
  END IF;

  IF v_credit_note.business_id IS DISTINCT FROM _business_id THEN
    RAISE EXCEPTION 'Credit note business mismatch (cn=%, expected=%)',
      v_credit_note.business_id, _business_id;
  END IF;

  v_available_credit := v_credit_note.total - COALESCE(v_credit_note.amount_applied, 0);
  IF _amount > v_available_credit THEN
    RAISE EXCEPTION 'Amount (%) exceeds available credit (%)', _amount, v_available_credit;
  END IF;

  SELECT id, invoice_number, total, amount_paid, status,
         business_id, branch_id
    INTO v_invoice
    FROM invoices
   WHERE id = _invoice_id
     AND organization_id = _org_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found';
  END IF;

  IF v_invoice.business_id IS DISTINCT FROM _business_id THEN
    RAISE EXCEPTION 'Invoice business mismatch (inv=%, expected=%)',
      v_invoice.business_id, _business_id;
  END IF;

  IF v_credit_note.business_id IS DISTINCT FROM v_invoice.business_id THEN
    RAISE EXCEPTION 'Cross-business credit application is not allowed';
  END IF;

  IF v_credit_note.branch_id IS NOT NULL
     AND v_invoice.branch_id IS NOT NULL
     AND v_credit_note.branch_id IS DISTINCT FROM v_invoice.branch_id THEN
    RAISE EXCEPTION 'Cross-branch credit application is not allowed (cn branch=%, invoice branch=%)',
      v_credit_note.branch_id, v_invoice.branch_id;
  END IF;

  v_target_branch := COALESCE(v_invoice.branch_id, v_credit_note.branch_id, _branch_id);

  v_invoice_balance := v_invoice.total - COALESCE(v_invoice.amount_paid, 0);
  IF _amount > v_invoice_balance THEN
    RAISE EXCEPTION 'Amount (%) exceeds invoice balance (%)', _amount, v_invoice_balance;
  END IF;

  INSERT INTO credit_note_applications (
    credit_note_id, invoice_id, amount, applied_by, notes,
    business_id, branch_id
  ) VALUES (
    _credit_note_id, _invoice_id, _amount, _applied_by, _notes,
    _business_id, v_target_branch
  ) RETURNING id INTO v_application_id;

  v_new_cn_applied := COALESCE(v_credit_note.amount_applied, 0) + _amount;
  IF v_new_cn_applied >= v_credit_note.total THEN
    v_new_cn_status := 'applied';
  ELSE
    v_new_cn_status := 'issued';
  END IF;

  UPDATE credit_notes
     SET amount_applied = v_new_cn_applied,
         status = v_new_cn_status::credit_note_status
   WHERE id = _credit_note_id;

  v_new_inv_paid := COALESCE(v_invoice.amount_paid, 0) + _amount;
  IF v_new_inv_paid >= v_invoice.total THEN
    v_new_inv_status := 'paid';
  ELSIF v_new_inv_paid > 0 THEN
    v_new_inv_status := 'partial';
  ELSE
    v_new_inv_status := 'sent';
  END IF;

  UPDATE invoices
     SET amount_paid = v_new_inv_paid,
         status = v_new_inv_status::invoice_status
   WHERE id = _invoice_id;

  IF _customer_deposits_account_id IS NOT NULL AND _receivable_account_id IS NOT NULL THEN
    LOOP
      BEGIN
        v_je_number := generate_next_je_number(_org_id);

        INSERT INTO journal_entries (
          organization_id, business_id, branch_id, entry_number, entry_date,
          reference, description, source_type, source_id, status, created_by
        ) VALUES (
          _org_id, _business_id, v_target_branch, v_je_number,
          CURRENT_DATE,
          'CNA-' || v_credit_note.credit_note_number || '-' || v_invoice.invoice_number,
          'Apply credit ' || v_credit_note.credit_note_number || ' to invoice ' || v_invoice.invoice_number,
          'credit_application', v_application_id, 'posted', _applied_by
        ) RETURNING id INTO v_je_id;

        EXIT;
      EXCEPTION WHEN unique_violation THEN
        v_retry := v_retry + 1;
        IF v_retry >= v_max_retries THEN
          RAISE EXCEPTION 'Could not generate unique JE number after % retries', v_max_retries;
        END IF;
      END;
    END LOOP;

    INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description, branch_id)
    VALUES (v_je_id, _customer_deposits_account_id, _amount, 0,
            'Credit applied: ' || v_credit_note.credit_note_number || ' → ' || v_invoice.invoice_number,
            v_target_branch);

    INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description, branch_id)
    VALUES (v_je_id, _receivable_account_id, 0, _amount,
            'AR reduction from credit: ' || v_credit_note.credit_note_number || ' → ' || v_invoice.invoice_number,
            v_target_branch);
  END IF;

  RETURN jsonb_build_object(
    'application_id', v_application_id,
    'journal_entry_id', v_je_id,
    'branch_id', v_target_branch,
    'credit_note_new_status', v_new_cn_status,
    'credit_note_amount_applied', v_new_cn_applied,
    'invoice_new_status', v_new_inv_status,
    'invoice_amount_paid', v_new_inv_paid
  );
END;
$function$;