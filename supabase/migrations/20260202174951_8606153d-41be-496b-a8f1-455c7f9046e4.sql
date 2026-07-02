-- ============================================
-- Admin DELETE Policies for Critical Tables
-- This migration adds DELETE policies for admins/owners
-- to fix silent deletion failures
-- ============================================

-- 1. AUDIT LOGS - Allow admins to delete audit logs
CREATE POLICY "Admins can delete audit logs"
ON public.audit_logs FOR DELETE
USING (
  organization_id IN (SELECT public.get_user_organizations(auth.uid()))
  AND (
    public.has_role(auth.uid(), organization_id, 'owner'::public.app_role) OR
    public.has_role(auth.uid(), organization_id, 'admin'::public.app_role) OR
    public.has_role(auth.uid(), organization_id, 'super_admin'::public.app_role)
  )
);

-- 2. BILLS - Allow admins to delete ANY bill (not just draft)
CREATE POLICY "Admins can delete all bills"
ON public.bills FOR DELETE
USING (
  organization_id IN (SELECT public.get_user_organizations(auth.uid()))
  AND (
    public.has_role(auth.uid(), organization_id, 'owner'::public.app_role) OR
    public.has_role(auth.uid(), organization_id, 'admin'::public.app_role) OR
    public.has_role(auth.uid(), organization_id, 'super_admin'::public.app_role)
  )
);

-- 3. BILL ITEMS - Allow admins to delete bill items
CREATE POLICY "Admins can delete bill items"
ON public.bill_items FOR DELETE
USING (
  EXISTS (
    SELECT 1 FROM public.bills b
    WHERE b.id = bill_items.bill_id
    AND b.organization_id IN (SELECT public.get_user_organizations(auth.uid()))
    AND (
      public.has_role(auth.uid(), b.organization_id, 'owner'::public.app_role) OR
      public.has_role(auth.uid(), b.organization_id, 'admin'::public.app_role) OR
      public.has_role(auth.uid(), b.organization_id, 'super_admin'::public.app_role)
    )
  )
);

-- 4. BILL PAYMENTS - Allow admins to delete bill payments
CREATE POLICY "Admins can delete bill payments"
ON public.bill_payments FOR DELETE
USING (
  organization_id IN (SELECT public.get_user_organizations(auth.uid()))
  AND (
    public.has_role(auth.uid(), organization_id, 'owner'::public.app_role) OR
    public.has_role(auth.uid(), organization_id, 'admin'::public.app_role) OR
    public.has_role(auth.uid(), organization_id, 'super_admin'::public.app_role)
  )
);

-- 5. INVOICES - Allow admins to delete any invoice (override existing draft-only policy)
CREATE POLICY "Admins can delete all invoices"
ON public.invoices FOR DELETE
USING (
  organization_id IN (SELECT public.get_user_organizations(auth.uid()))
  AND (
    public.has_role(auth.uid(), organization_id, 'owner'::public.app_role) OR
    public.has_role(auth.uid(), organization_id, 'admin'::public.app_role) OR
    public.has_role(auth.uid(), organization_id, 'super_admin'::public.app_role)
  )
);

-- 6. PAYMENTS - Allow admins to delete payments
CREATE POLICY "Admins can delete payments"
ON public.payments FOR DELETE
USING (
  organization_id IN (SELECT public.get_user_organizations(auth.uid()))
  AND (
    public.has_role(auth.uid(), organization_id, 'owner'::public.app_role) OR
    public.has_role(auth.uid(), organization_id, 'admin'::public.app_role) OR
    public.has_role(auth.uid(), organization_id, 'super_admin'::public.app_role)
  )
);

-- 7. EXPENSES - Allow admins to delete expenses
CREATE POLICY "Admins can delete all expenses"
ON public.expenses FOR DELETE
USING (
  organization_id IN (SELECT public.get_user_organizations(auth.uid()))
  AND (
    public.has_role(auth.uid(), organization_id, 'owner'::public.app_role) OR
    public.has_role(auth.uid(), organization_id, 'admin'::public.app_role) OR
    public.has_role(auth.uid(), organization_id, 'super_admin'::public.app_role)
  )
);

-- 8. BANK TRANSACTIONS - Allow admins to delete
CREATE POLICY "Admins can delete bank transactions"
ON public.bank_transactions FOR DELETE
USING (
  organization_id IN (SELECT public.get_user_organizations(auth.uid()))
  AND (
    public.has_role(auth.uid(), organization_id, 'owner'::public.app_role) OR
    public.has_role(auth.uid(), organization_id, 'admin'::public.app_role) OR
    public.has_role(auth.uid(), organization_id, 'super_admin'::public.app_role)
  )
);

-- 9. JOURNAL ENTRIES - Allow admins to delete
CREATE POLICY "Admins can delete journal entries"
ON public.journal_entries FOR DELETE
USING (
  organization_id IN (SELECT public.get_user_organizations(auth.uid()))
  AND (
    public.has_role(auth.uid(), organization_id, 'owner'::public.app_role) OR
    public.has_role(auth.uid(), organization_id, 'admin'::public.app_role) OR
    public.has_role(auth.uid(), organization_id, 'super_admin'::public.app_role)
  )
);

-- 10. JOURNAL ENTRY LINES - Allow admins to delete
CREATE POLICY "Admins can delete journal entry lines"
ON public.journal_entry_lines FOR DELETE
USING (
  EXISTS (
    SELECT 1 FROM public.journal_entries je
    WHERE je.id = journal_entry_lines.journal_entry_id
    AND je.organization_id IN (SELECT public.get_user_organizations(auth.uid()))
    AND (
      public.has_role(auth.uid(), je.organization_id, 'owner'::public.app_role) OR
      public.has_role(auth.uid(), je.organization_id, 'admin'::public.app_role) OR
      public.has_role(auth.uid(), je.organization_id, 'super_admin'::public.app_role)
    )
  )
);

-- 11. PURCHASE ORDERS - Allow admins to delete
CREATE POLICY "Admins can delete purchase orders"
ON public.purchase_orders FOR DELETE
USING (
  organization_id IN (SELECT public.get_user_organizations(auth.uid()))
  AND (
    public.has_role(auth.uid(), organization_id, 'owner'::public.app_role) OR
    public.has_role(auth.uid(), organization_id, 'admin'::public.app_role) OR
    public.has_role(auth.uid(), organization_id, 'super_admin'::public.app_role)
  )
);

-- 12. PURCHASE ORDER ITEMS - Allow admins to delete
CREATE POLICY "Admins can delete purchase order items"
ON public.purchase_order_items FOR DELETE
USING (
  EXISTS (
    SELECT 1 FROM public.purchase_orders po
    WHERE po.id = purchase_order_items.purchase_order_id
    AND po.organization_id IN (SELECT public.get_user_organizations(auth.uid()))
    AND (
      public.has_role(auth.uid(), po.organization_id, 'owner'::public.app_role) OR
      public.has_role(auth.uid(), po.organization_id, 'admin'::public.app_role) OR
      public.has_role(auth.uid(), po.organization_id, 'super_admin'::public.app_role)
    )
  )
);

-- 13. SALES ORDERS - Allow admins to delete
CREATE POLICY "Admins can delete sales orders"
ON public.sales_orders FOR DELETE
USING (
  organization_id IN (SELECT public.get_user_organizations(auth.uid()))
  AND (
    public.has_role(auth.uid(), organization_id, 'owner'::public.app_role) OR
    public.has_role(auth.uid(), organization_id, 'admin'::public.app_role) OR
    public.has_role(auth.uid(), organization_id, 'super_admin'::public.app_role)
  )
);

-- 14. CRM LEADS - Allow admins to delete
CREATE POLICY "Admins can delete CRM leads"
ON public.crm_leads FOR DELETE
USING (
  organization_id IN (SELECT public.get_user_organizations(auth.uid()))
  AND (
    public.has_role(auth.uid(), organization_id, 'owner'::public.app_role) OR
    public.has_role(auth.uid(), organization_id, 'admin'::public.app_role) OR
    public.has_role(auth.uid(), organization_id, 'super_admin'::public.app_role)
  )
);

-- 15. CRM ACTIVITIES - Allow admins to delete
CREATE POLICY "Admins can delete CRM activities"
ON public.crm_activities FOR DELETE
USING (
  organization_id IN (SELECT public.get_user_organizations(auth.uid()))
  AND (
    public.has_role(auth.uid(), organization_id, 'owner'::public.app_role) OR
    public.has_role(auth.uid(), organization_id, 'admin'::public.app_role) OR
    public.has_role(auth.uid(), organization_id, 'super_admin'::public.app_role)
  )
);

-- 16. PROJECTS - Allow admins to delete
CREATE POLICY "Admins can delete projects"
ON public.projects FOR DELETE
USING (
  organization_id IN (SELECT public.get_user_organizations(auth.uid()))
  AND (
    public.has_role(auth.uid(), organization_id, 'owner'::public.app_role) OR
    public.has_role(auth.uid(), organization_id, 'admin'::public.app_role) OR
    public.has_role(auth.uid(), organization_id, 'super_admin'::public.app_role)
  )
);

-- 17. PRODUCTS - Allow admins to delete
CREATE POLICY "Admins can delete products"
ON public.products FOR DELETE
USING (
  organization_id IN (SELECT public.get_user_organizations(auth.uid()))
  AND (
    public.has_role(auth.uid(), organization_id, 'owner'::public.app_role) OR
    public.has_role(auth.uid(), organization_id, 'admin'::public.app_role) OR
    public.has_role(auth.uid(), organization_id, 'super_admin'::public.app_role)
  )
);

-- 18. CONTACTS - Allow admins to delete
CREATE POLICY "Admins can delete contacts"
ON public.contacts FOR DELETE
USING (
  organization_id IN (SELECT public.get_user_organizations(auth.uid()))
  AND (
    public.has_role(auth.uid(), organization_id, 'owner'::public.app_role) OR
    public.has_role(auth.uid(), organization_id, 'admin'::public.app_role) OR
    public.has_role(auth.uid(), organization_id, 'super_admin'::public.app_role)
  )
);

-- 19. ACCOUNTS (Chart of Accounts) - Allow admins to delete
CREATE POLICY "Admins can delete accounts"
ON public.accounts FOR DELETE
USING (
  organization_id IN (SELECT public.get_user_organizations(auth.uid()))
  AND (
    public.has_role(auth.uid(), organization_id, 'owner'::public.app_role) OR
    public.has_role(auth.uid(), organization_id, 'admin'::public.app_role) OR
    public.has_role(auth.uid(), organization_id, 'super_admin'::public.app_role)
  )
);

-- 20. FIXED ASSETS - Allow admins to delete
CREATE POLICY "Admins can delete fixed assets"
ON public.fixed_assets FOR DELETE
USING (
  organization_id IN (SELECT public.get_user_organizations(auth.uid()))
  AND (
    public.has_role(auth.uid(), organization_id, 'owner'::public.app_role) OR
    public.has_role(auth.uid(), organization_id, 'admin'::public.app_role) OR
    public.has_role(auth.uid(), organization_id, 'super_admin'::public.app_role)
  )
);

-- 21. CREDIT NOTES - Allow admins to delete
CREATE POLICY "Admins can delete credit notes"
ON public.credit_notes FOR DELETE
USING (
  organization_id IN (SELECT public.get_user_organizations(auth.uid()))
  AND (
    public.has_role(auth.uid(), organization_id, 'owner'::public.app_role) OR
    public.has_role(auth.uid(), organization_id, 'admin'::public.app_role) OR
    public.has_role(auth.uid(), organization_id, 'super_admin'::public.app_role)
  )
);

-- 22. ESTIMATES - Allow admins to delete
CREATE POLICY "Admins can delete estimates"
ON public.estimates FOR DELETE
USING (
  organization_id IN (SELECT public.get_user_organizations(auth.uid()))
  AND (
    public.has_role(auth.uid(), organization_id, 'owner'::public.app_role) OR
    public.has_role(auth.uid(), organization_id, 'admin'::public.app_role) OR
    public.has_role(auth.uid(), organization_id, 'super_admin'::public.app_role)
  )
);

-- 23. BANK ACCOUNTS - Allow admins to delete
CREATE POLICY "Admins can delete bank accounts"
ON public.bank_accounts FOR DELETE
USING (
  organization_id IN (SELECT public.get_user_organizations(auth.uid()))
  AND (
    public.has_role(auth.uid(), organization_id, 'owner'::public.app_role) OR
    public.has_role(auth.uid(), organization_id, 'admin'::public.app_role) OR
    public.has_role(auth.uid(), organization_id, 'super_admin'::public.app_role)
  )
);

-- 24. BUDGETS - Allow admins to delete
CREATE POLICY "Admins can delete budgets"
ON public.budgets FOR DELETE
USING (
  organization_id IN (SELECT public.get_user_organizations(auth.uid()))
  AND (
    public.has_role(auth.uid(), organization_id, 'owner'::public.app_role) OR
    public.has_role(auth.uid(), organization_id, 'admin'::public.app_role) OR
    public.has_role(auth.uid(), organization_id, 'super_admin'::public.app_role)
  )
);