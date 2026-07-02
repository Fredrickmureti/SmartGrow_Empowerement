
-- ============================================================================
-- 1) confirm_vendor_credit_note_atomic
-- ============================================================================
CREATE OR REPLACE FUNCTION public.confirm_vendor_credit_note_atomic(
  _vcn_id uuid,
  _user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_vcn          RECORD;
  v_ap_account   uuid;
  v_exp_account  uuid;
  v_je_id        uuid;
  v_je_number    text;
  v_attempts     int := 0;
  v_max_attempts int := 20;
BEGIN
  -- Lock the VCN
  SELECT id, organization_id, business_id, branch_id, vendor_id,
         credit_note_number, credit_date, total, status, journal_entry_id
    INTO v_vcn
    FROM vendor_credit_notes
   WHERE id = _vcn_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Vendor credit note not found';
  END IF;

  IF v_vcn.status <> 'draft' THEN
    RAISE EXCEPTION 'Only draft credit notes can be confirmed (current: %)', v_vcn.status;
  END IF;

  IF v_vcn.business_id IS NULL THEN
    RAISE EXCEPTION 'Vendor credit note % has no business_id; cannot resolve account mappings', v_vcn.credit_note_number;
  END IF;

  IF v_vcn.total IS NULL OR v_vcn.total <= 0 THEN
    RAISE EXCEPTION 'Vendor credit note % has non-positive total (%); cannot post', v_vcn.credit_note_number, v_vcn.total;
  END IF;

  -- Resolve AP account from default_account_settings
  SELECT account_id INTO v_ap_account
    FROM default_account_settings
   WHERE organization_id = v_vcn.organization_id
     AND business_id     = v_vcn.business_id
     AND setting_key     = 'accounts_payable'
   LIMIT 1;

  -- Resolve expense account: operating_expenses → cogs fallback
  SELECT account_id INTO v_exp_account
    FROM default_account_settings
   WHERE organization_id = v_vcn.organization_id
     AND business_id     = v_vcn.business_id
     AND setting_key     IN ('operating_expenses','cogs')
   ORDER BY CASE setting_key WHEN 'operating_expenses' THEN 0 ELSE 1 END
   LIMIT 1;

  IF v_ap_account IS NULL OR v_exp_account IS NULL THEN
    RAISE EXCEPTION 'Cannot confirm VCN: missing default account mapping (AP=%, Expense=%). Configure in Settings > Default Accounts.',
      v_ap_account, v_exp_account;
  END IF;

  -- Allocate JE number with collision retry
  LOOP
    v_attempts := v_attempts + 1;
    IF v_attempts > v_max_attempts THEN
      RAISE EXCEPTION 'Unable to allocate JE number after % attempts', v_max_attempts;
    END IF;

    v_je_number := generate_next_je_number(v_vcn.organization_id, v_vcn.business_id);

    BEGIN
      INSERT INTO journal_entries (
        organization_id, business_id, branch_id,
        entry_number, entry_date, reference, description,
        source_type, source_id, status, created_by
      ) VALUES (
        v_vcn.organization_id, v_vcn.business_id, v_vcn.branch_id,
        v_je_number, v_vcn.credit_date,
        v_vcn.credit_note_number,
        'Vendor credit note ' || v_vcn.credit_note_number,
        'vendor_credit_note', v_vcn.id, 'posted', _user_id
      ) RETURNING id INTO v_je_id;
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      IF POSITION('journal_entries_organization_id_entry_number_key' IN SQLERRM) > 0 THEN
        CONTINUE;
      ELSE RAISE;
      END IF;
    END;
  END LOOP;

  -- Post the lines: Dr AP, Cr Expense
  INSERT INTO journal_entry_lines (
    journal_entry_id, account_id, debit, credit, description, contact_id,
    business_id, branch_id, sort_order
  ) VALUES (
    v_je_id, v_ap_account, v_vcn.total, 0,
    'VCN ' || v_vcn.credit_note_number || ' — AP reduction',
    v_vcn.vendor_id, v_vcn.business_id, v_vcn.branch_id, 0
  );

  INSERT INTO journal_entry_lines (
    journal_entry_id, account_id, debit, credit, description,
    business_id, branch_id, sort_order
  ) VALUES (
    v_je_id, v_exp_account, 0, v_vcn.total,
    'VCN ' || v_vcn.credit_note_number || ' — expense credit',
    v_vcn.business_id, v_vcn.branch_id, 1
  );

  -- Flip status + link
  UPDATE vendor_credit_notes
     SET status = 'confirmed',
         journal_entry_id = v_je_id,
         updated_at = now()
   WHERE id = _vcn_id;

  RETURN jsonb_build_object(
    'success', true,
    'journal_entry_id', v_je_id,
    'journal_entry_number', v_je_number
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.confirm_vendor_credit_note_atomic(uuid, uuid) TO authenticated;

-- ============================================================================
-- 2) confirm_bill_atomic
-- ============================================================================
CREATE OR REPLACE FUNCTION public.confirm_bill_atomic(
  _bill_id uuid,
  _user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bill          RECORD;
  v_vendor_ap     uuid;
  v_default_ap    uuid;
  v_default_exp   uuid;
  v_default_inv   uuid;
  v_default_tax   uuid;
  v_effective_ap  uuid;
  v_je_id         uuid;
  v_je_number     text;
  v_attempts      int := 0;
  v_max_attempts  int := 20;
  v_total_debits  numeric := 0;
  v_sort          int := 0;
BEGIN
  -- Lock bill
  SELECT id, organization_id, business_id, branch_id, vendor_id,
         bill_number, bill_date, status, subtotal, tax_amount, total,
         journal_entry_id
    INTO v_bill
    FROM bills
   WHERE id = _bill_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Bill not found';
  END IF;

  IF v_bill.status <> 'draft' THEN
    RAISE EXCEPTION 'Only draft bills can be confirmed (current: %)', v_bill.status;
  END IF;

  IF v_bill.business_id IS NULL THEN
    RAISE EXCEPTION 'Bill % has no business_id', v_bill.bill_number;
  END IF;

  IF v_bill.total IS NULL OR v_bill.total <= 0 THEN
    RAISE EXCEPTION 'Bill % has non-positive total (%); cannot confirm', v_bill.bill_number, v_bill.total;
  END IF;

  -- Resolve default mappings
  SELECT account_id INTO v_default_ap FROM default_account_settings
    WHERE organization_id = v_bill.organization_id AND business_id = v_bill.business_id AND setting_key='accounts_payable' LIMIT 1;
  SELECT account_id INTO v_default_exp FROM default_account_settings
    WHERE organization_id = v_bill.organization_id AND business_id = v_bill.business_id AND setting_key IN ('operating_expenses','cogs')
    ORDER BY CASE setting_key WHEN 'operating_expenses' THEN 0 ELSE 1 END LIMIT 1;
  SELECT account_id INTO v_default_inv FROM default_account_settings
    WHERE organization_id = v_bill.organization_id AND business_id = v_bill.business_id AND setting_key='inventory' LIMIT 1;
  SELECT account_id INTO v_default_tax FROM default_account_settings
    WHERE organization_id = v_bill.organization_id AND business_id = v_bill.business_id AND setting_key='input_tax' LIMIT 1;

  IF v_default_ap IS NULL OR v_default_exp IS NULL THEN
    RAISE EXCEPTION 'Cannot confirm bill: Accounts Payable and Expense accounts must be mapped (AP=%, Expense=%). Go to Settings > Default Accounts.',
      v_default_ap, v_default_exp;
  END IF;

  -- Vendor AP override
  IF v_bill.vendor_id IS NOT NULL THEN
    SELECT default_payable_account_id INTO v_vendor_ap
      FROM contacts WHERE id = v_bill.vendor_id;
  END IF;
  v_effective_ap := COALESCE(v_vendor_ap, v_default_ap);

  -- Allocate JE number with collision retry
  LOOP
    v_attempts := v_attempts + 1;
    IF v_attempts > v_max_attempts THEN
      RAISE EXCEPTION 'Unable to allocate JE number after % attempts', v_max_attempts;
    END IF;
    v_je_number := generate_next_je_number(v_bill.organization_id, v_bill.business_id);
    BEGIN
      INSERT INTO journal_entries (
        organization_id, business_id, branch_id,
        entry_number, entry_date, reference, description,
        source_type, source_id, status, created_by
      ) VALUES (
        v_bill.organization_id, v_bill.business_id, v_bill.branch_id,
        v_je_number, v_bill.bill_date,
        v_bill.bill_number,
        'Bill ' || v_bill.bill_number || ' confirmed',
        'bill', v_bill.id, 'posted', _user_id
      ) RETURNING id INTO v_je_id;
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      IF POSITION('journal_entries_organization_id_entry_number_key' IN SQLERRM) > 0 THEN
        CONTINUE;
      ELSE RAISE;
      END IF;
    END;
  END LOOP;

  -- Build debit lines: group bill items by resolved expense/inventory account.
  -- Resolution priority per line: bill_items.account_id > product.inventory_account_id (when track_inventory)
  --   > product.purchase_account_id > contacts.default_expense_account_id > system default.
  WITH resolved AS (
    SELECT
      COALESCE(
        bi.account_id,
        CASE WHEN p.track_inventory IS TRUE THEN COALESCE(p.inventory_account_id, v_default_inv) END,
        p.purchase_account_id,
        c.default_expense_account_id,
        v_default_exp
      ) AS acct_id,
      SUM(bi.line_total) AS amt
    FROM bill_items bi
    LEFT JOIN products p ON p.id = bi.product_id
    LEFT JOIN contacts c ON c.id = v_bill.vendor_id
    WHERE bi.bill_id = v_bill.id
    GROUP BY 1
  )
  INSERT INTO journal_entry_lines (
    journal_entry_id, account_id, debit, credit, description,
    business_id, branch_id, sort_order
  )
  SELECT
    v_je_id, r.acct_id, ROUND(r.amt, 2), 0,
    'Bill ' || v_bill.bill_number || ' — line group',
    v_bill.business_id, v_bill.branch_id,
    ROW_NUMBER() OVER (ORDER BY r.acct_id) - 1
  FROM resolved r
  WHERE r.acct_id IS NOT NULL;

  GET DIAGNOSTICS v_sort = ROW_COUNT;

  -- Fallback: if no items existed, debit subtotal to default expense
  IF v_sort = 0 AND v_bill.subtotal IS NOT NULL AND v_bill.subtotal > 0 THEN
    INSERT INTO journal_entry_lines (
      journal_entry_id, account_id, debit, credit, description,
      business_id, branch_id, sort_order
    ) VALUES (
      v_je_id, v_default_exp, ROUND(v_bill.subtotal, 2), 0,
      'Bill ' || v_bill.bill_number || ' — expense (no lines)',
      v_bill.business_id, v_bill.branch_id, 0
    );
    v_sort := 1;
  END IF;

  -- Tax line
  IF COALESCE(v_bill.tax_amount, 0) > 0 THEN
    IF v_default_tax IS NULL THEN
      RAISE EXCEPTION 'Bill % has tax of % but no Input Tax account is mapped. Configure in Settings > Default Accounts.',
        v_bill.bill_number, v_bill.tax_amount;
    END IF;
    INSERT INTO journal_entry_lines (
      journal_entry_id, account_id, debit, credit, description,
      business_id, branch_id, sort_order
    ) VALUES (
      v_je_id, v_default_tax, ROUND(v_bill.tax_amount, 2), 0,
      'Bill ' || v_bill.bill_number || ' — input tax',
      v_bill.business_id, v_bill.branch_id, v_sort
    );
    v_sort := v_sort + 1;
  END IF;

  -- Sum debits to derive credit amount (handles small rounding by deferring to total)
  SELECT COALESCE(SUM(debit), 0) INTO v_total_debits
    FROM journal_entry_lines WHERE journal_entry_id = v_je_id;

  -- Credit AP for the bill total. If rounding caused a tiny mismatch (< 0.01),
  -- adjust the largest debit line to make the JE balance exactly.
  IF ABS(v_total_debits - v_bill.total) > 0.001 AND ABS(v_total_debits - v_bill.total) < 0.05 THEN
    UPDATE journal_entry_lines
       SET debit = debit + (v_bill.total - v_total_debits)
     WHERE id = (
       SELECT id FROM journal_entry_lines
        WHERE journal_entry_id = v_je_id AND debit > 0
        ORDER BY debit DESC LIMIT 1
     );
  ELSIF ABS(v_total_debits - v_bill.total) >= 0.05 THEN
    RAISE EXCEPTION 'Bill % cannot be balanced: line debits=%, bill total=%',
      v_bill.bill_number, v_total_debits, v_bill.total;
  END IF;

  INSERT INTO journal_entry_lines (
    journal_entry_id, account_id, debit, credit, description, contact_id,
    business_id, branch_id, sort_order
  ) VALUES (
    v_je_id, v_effective_ap, 0, v_bill.total,
    'Bill ' || v_bill.bill_number || ' — Accounts Payable',
    v_bill.vendor_id, v_bill.business_id, v_bill.branch_id, v_sort
  );

  -- Flip bill status + link
  UPDATE bills
     SET status = 'received'::bill_status,
         journal_entry_id = v_je_id,
         updated_at = now()
   WHERE id = v_bill.id;

  RETURN jsonb_build_object(
    'success', true,
    'journal_entry_id', v_je_id,
    'journal_entry_number', v_je_number,
    'status', 'received'
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.confirm_bill_atomic(uuid, uuid) TO authenticated;

-- ============================================================================
-- 3) convert_po_to_bill_atomic
-- ============================================================================
CREATE OR REPLACE FUNCTION public.convert_po_to_bill_atomic(
  _po_id uuid,
  _user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_po         RECORD;
  v_bill_id    uuid;
  v_bill_no    text;
  v_attempts   int := 0;
  v_max        int := 20;
BEGIN
  -- Lock PO
  SELECT id, organization_id, business_id, branch_id, vendor_id,
         po_number, currency, subtotal, tax_amount, discount_amount, total,
         notes, status, billing_status, converted_bill_id
    INTO v_po
    FROM purchase_orders
   WHERE id = _po_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Purchase order not found';
  END IF;

  IF v_po.converted_bill_id IS NOT NULL THEN
    RAISE EXCEPTION 'Purchase order % already converted to a bill (%)', v_po.po_number, v_po.converted_bill_id;
  END IF;

  -- Allocate next bill number with collision retry
  LOOP
    v_attempts := v_attempts + 1;
    IF v_attempts > v_max THEN
      RAISE EXCEPTION 'Unable to allocate bill number after % attempts', v_max;
    END IF;
    v_bill_no := get_next_bill_number(v_po.organization_id);
    BEGIN
      INSERT INTO bills (
        organization_id, business_id, branch_id, vendor_id,
        bill_number, status, bill_date, due_date,
        subtotal, tax_amount, discount_amount, total,
        currency, notes, created_by, source_purchase_order_id
      ) VALUES (
        v_po.organization_id, v_po.business_id, v_po.branch_id, v_po.vendor_id,
        v_bill_no, 'draft'::bill_status, CURRENT_DATE, CURRENT_DATE + INTERVAL '30 days',
        v_po.subtotal, v_po.tax_amount, COALESCE(v_po.discount_amount, 0), v_po.total,
        v_po.currency, v_po.notes, _user_id, v_po.id
      ) RETURNING id INTO v_bill_id;
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      -- bill_number unique key collision -> retry
      CONTINUE;
    END;
  END LOOP;

  -- Copy items, linking back to PO line for the 3-way match trigger
  INSERT INTO bill_items (
    bill_id, product_id, purchase_order_item_id,
    description, quantity, unit_price, tax_rate, tax_amount, line_total, sort_order
  )
  SELECT v_bill_id, poi.product_id, poi.id,
         poi.description, poi.quantity, poi.unit_price,
         COALESCE(poi.tax_rate, 0), COALESCE(poi.tax_amount, 0),
         poi.line_total, COALESCE(poi.sort_order, 0)
    FROM purchase_order_items poi
   WHERE poi.purchase_order_id = v_po.id;

  -- Mark PO billed (uses inline logic instead of recursive RPC)
  UPDATE purchase_order_items
     SET quantity_billed = quantity
   WHERE purchase_order_id = v_po.id;

  UPDATE purchase_orders
     SET converted_bill_id = v_bill_id,
         billing_status    = 'fully_billed',
         updated_at        = now()
   WHERE id = v_po.id;

  RETURN jsonb_build_object(
    'success', true,
    'bill_id', v_bill_id,
    'bill_number', v_bill_no
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.convert_po_to_bill_atomic(uuid, uuid) TO authenticated;

-- ============================================================================
-- 4) purchase_order_items RLS consolidation
-- ============================================================================
DROP POLICY IF EXISTS "Users can manage PO items"               ON public.purchase_order_items;
DROP POLICY IF EXISTS "Users can view PO items"                 ON public.purchase_order_items;
DROP POLICY IF EXISTS "Admins can delete purchase order items"  ON public.purchase_order_items;

-- Anyone in the org with visibility on the parent PO can read its items
CREATE POLICY purchase_order_items_select_v2
  ON public.purchase_order_items FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM purchase_orders po
       WHERE po.id = purchase_order_items.purchase_order_id
         AND po.organization_id IN (SELECT get_user_organizations(auth.uid()))
    )
  );

CREATE POLICY purchase_order_items_insert_v2
  ON public.purchase_order_items FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM purchase_orders po
       WHERE po.id = purchase_order_items.purchase_order_id
         AND po.organization_id IN (SELECT get_user_organizations(auth.uid()))
    )
  );

CREATE POLICY purchase_order_items_update_v2
  ON public.purchase_order_items FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM purchase_orders po
       WHERE po.id = purchase_order_items.purchase_order_id
         AND po.organization_id IN (SELECT get_user_organizations(auth.uid()))
    )
  );

CREATE POLICY purchase_order_items_delete_v2
  ON public.purchase_order_items FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM purchase_orders po
       WHERE po.id = purchase_order_items.purchase_order_id
         AND po.organization_id IN (SELECT get_user_organizations(auth.uid()))
         AND (
           has_role(auth.uid(), po.organization_id, 'owner'::app_role)
           OR has_role(auth.uid(), po.organization_id, 'admin'::app_role)
           OR has_role(auth.uid(), po.organization_id, 'super_admin'::app_role)
           OR has_role(auth.uid(), po.organization_id, 'accountant'::app_role)
           OR has_role(auth.uid(), po.organization_id, 'staff'::app_role)
         )
    )
  );
