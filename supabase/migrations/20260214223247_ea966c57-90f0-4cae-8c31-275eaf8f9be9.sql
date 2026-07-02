
-- ============================================================
-- COMPREHENSIVE RLS OVERHAUL: Apply module-level permission checks
-- to ALL app tables using user_has_module_permission()
-- ============================================================

-- ===================== CONTACTS MODULE =====================

DROP POLICY IF EXISTS "Users can view contacts in their organizations" ON public.contacts;
DROP POLICY IF EXISTS "Users can create contacts in their organizations" ON public.contacts;
DROP POLICY IF EXISTS "Users can update contacts in their organizations" ON public.contacts;
DROP POLICY IF EXISTS "Users can delete contacts in their organizations" ON public.contacts;
DROP POLICY IF EXISTS "org_contacts_select" ON public.contacts;
DROP POLICY IF EXISTS "org_contacts_insert" ON public.contacts;
DROP POLICY IF EXISTS "org_contacts_update" ON public.contacts;
DROP POLICY IF EXISTS "org_contacts_delete" ON public.contacts;

CREATE POLICY "contacts_select_perm" ON public.contacts FOR SELECT TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'contacts', 'read'));
CREATE POLICY "contacts_insert_perm" ON public.contacts FOR INSERT TO authenticated
  WITH CHECK (public.user_has_module_permission(auth.uid(), organization_id, 'contacts', 'create'));
CREATE POLICY "contacts_update_perm" ON public.contacts FOR UPDATE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'contacts', 'write'));
CREATE POLICY "contacts_delete_perm" ON public.contacts FOR DELETE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'contacts', 'delete'));

-- customer_groups
DROP POLICY IF EXISTS "Users can view their org's customer groups" ON public.customer_groups;
DROP POLICY IF EXISTS "Users can insert customer groups in their org" ON public.customer_groups;
DROP POLICY IF EXISTS "Users can update their org's customer groups" ON public.customer_groups;
DROP POLICY IF EXISTS "Users can delete their org's customer groups" ON public.customer_groups;

CREATE POLICY "customer_groups_select_perm" ON public.customer_groups FOR SELECT TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'contacts', 'read'));
CREATE POLICY "customer_groups_insert_perm" ON public.customer_groups FOR INSERT TO authenticated
  WITH CHECK (public.user_has_module_permission(auth.uid(), organization_id, 'contacts', 'create'));
CREATE POLICY "customer_groups_update_perm" ON public.customer_groups FOR UPDATE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'contacts', 'write'));
CREATE POLICY "customer_groups_delete_perm" ON public.customer_groups FOR DELETE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'contacts', 'delete'));

-- customer_loyalty (no org_id - join via contact_id -> contacts)
DROP POLICY IF EXISTS "Users can view customer loyalty in their organizations" ON public.customer_loyalty;
DROP POLICY IF EXISTS "Users can insert customer loyalty in their organizations" ON public.customer_loyalty;
DROP POLICY IF EXISTS "Users can update customer loyalty in their organizations" ON public.customer_loyalty;

CREATE POLICY "customer_loyalty_select_perm" ON public.customer_loyalty FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.contacts c WHERE c.id = customer_loyalty.contact_id AND public.user_has_module_permission(auth.uid(), c.organization_id, 'contacts', 'read')));
CREATE POLICY "customer_loyalty_insert_perm" ON public.customer_loyalty FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.contacts c WHERE c.id = customer_loyalty.contact_id AND public.user_has_module_permission(auth.uid(), c.organization_id, 'contacts', 'create')));
CREATE POLICY "customer_loyalty_update_perm" ON public.customer_loyalty FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.contacts c WHERE c.id = customer_loyalty.contact_id AND public.user_has_module_permission(auth.uid(), c.organization_id, 'contacts', 'write')));

-- customer_statements
DROP POLICY IF EXISTS "Users can view customer statements in their organizations" ON public.customer_statements;
DROP POLICY IF EXISTS "Users can create customer statements in their organizations" ON public.customer_statements;
DROP POLICY IF EXISTS "Users can update customer statements in their organizations" ON public.customer_statements;
DROP POLICY IF EXISTS "Users can delete customer statements in their organizations" ON public.customer_statements;

CREATE POLICY "customer_statements_select_perm" ON public.customer_statements FOR SELECT TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'contacts', 'read'));
CREATE POLICY "customer_statements_insert_perm" ON public.customer_statements FOR INSERT TO authenticated
  WITH CHECK (public.user_has_module_permission(auth.uid(), organization_id, 'contacts', 'create'));
CREATE POLICY "customer_statements_update_perm" ON public.customer_statements FOR UPDATE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'contacts', 'write'));
CREATE POLICY "customer_statements_delete_perm" ON public.customer_statements FOR DELETE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'contacts', 'delete'));

-- ===================== PRODUCTS MODULE =====================

DROP POLICY IF EXISTS "Users can view products in their organizations" ON public.products;
DROP POLICY IF EXISTS "Users can create products in their organizations" ON public.products;
DROP POLICY IF EXISTS "Users can update products in their organizations" ON public.products;
DROP POLICY IF EXISTS "Users can delete products in their organizations" ON public.products;
DROP POLICY IF EXISTS "org_products_select" ON public.products;
DROP POLICY IF EXISTS "org_products_insert" ON public.products;
DROP POLICY IF EXISTS "org_products_update" ON public.products;
DROP POLICY IF EXISTS "org_products_delete" ON public.products;

CREATE POLICY "products_select_perm" ON public.products FOR SELECT TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'products', 'read'));
CREATE POLICY "products_insert_perm" ON public.products FOR INSERT TO authenticated
  WITH CHECK (public.user_has_module_permission(auth.uid(), organization_id, 'products', 'create'));
CREATE POLICY "products_update_perm" ON public.products FOR UPDATE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'products', 'write'));
CREATE POLICY "products_delete_perm" ON public.products FOR DELETE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'products', 'delete'));

-- ===================== SALES MODULE =====================

DROP POLICY IF EXISTS "Users can view invoices in their organizations" ON public.invoices;
DROP POLICY IF EXISTS "Users can create invoices in their organizations" ON public.invoices;
DROP POLICY IF EXISTS "Users can update invoices in their organizations" ON public.invoices;
DROP POLICY IF EXISTS "Users can delete invoices in their organizations" ON public.invoices;
DROP POLICY IF EXISTS "Admins can delete invoices" ON public.invoices;

CREATE POLICY "invoices_select_perm" ON public.invoices FOR SELECT TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'sales', 'read'));
CREATE POLICY "invoices_insert_perm" ON public.invoices FOR INSERT TO authenticated
  WITH CHECK (public.user_has_module_permission(auth.uid(), organization_id, 'sales', 'create'));
CREATE POLICY "invoices_update_perm" ON public.invoices FOR UPDATE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'sales', 'write'));
CREATE POLICY "invoices_delete_perm" ON public.invoices FOR DELETE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'sales', 'delete'));

DROP POLICY IF EXISTS "Users can manage invoice items" ON public.invoice_items;
DROP POLICY IF EXISTS "Users can view invoice items" ON public.invoice_items;
DROP POLICY IF EXISTS "Admins can delete invoice items" ON public.invoice_items;

CREATE POLICY "invoice_items_select_perm" ON public.invoice_items FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.invoices i WHERE i.id = invoice_items.invoice_id AND public.user_has_module_permission(auth.uid(), i.organization_id, 'sales', 'read')));
CREATE POLICY "invoice_items_insert_perm" ON public.invoice_items FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.invoices i WHERE i.id = invoice_items.invoice_id AND public.user_has_module_permission(auth.uid(), i.organization_id, 'sales', 'create')));
CREATE POLICY "invoice_items_update_perm" ON public.invoice_items FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.invoices i WHERE i.id = invoice_items.invoice_id AND public.user_has_module_permission(auth.uid(), i.organization_id, 'sales', 'write')));
CREATE POLICY "invoice_items_delete_perm" ON public.invoice_items FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.invoices i WHERE i.id = invoice_items.invoice_id AND public.user_has_module_permission(auth.uid(), i.organization_id, 'sales', 'delete')));

DROP POLICY IF EXISTS "Users can view estimates in their organizations" ON public.estimates;
DROP POLICY IF EXISTS "Users can create estimates in their organizations" ON public.estimates;
DROP POLICY IF EXISTS "Users can update estimates in their organizations" ON public.estimates;
DROP POLICY IF EXISTS "Users can delete estimates in their organizations" ON public.estimates;
DROP POLICY IF EXISTS "Admins can delete estimates" ON public.estimates;

CREATE POLICY "estimates_select_perm" ON public.estimates FOR SELECT TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'sales', 'read'));
CREATE POLICY "estimates_insert_perm" ON public.estimates FOR INSERT TO authenticated
  WITH CHECK (public.user_has_module_permission(auth.uid(), organization_id, 'sales', 'create'));
CREATE POLICY "estimates_update_perm" ON public.estimates FOR UPDATE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'sales', 'write'));
CREATE POLICY "estimates_delete_perm" ON public.estimates FOR DELETE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'sales', 'delete'));

DROP POLICY IF EXISTS "Users can manage estimate items" ON public.estimate_items;
DROP POLICY IF EXISTS "Users can view estimate items" ON public.estimate_items;
DROP POLICY IF EXISTS "Admins can delete estimate items" ON public.estimate_items;

CREATE POLICY "estimate_items_select_perm" ON public.estimate_items FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.estimates e WHERE e.id = estimate_items.estimate_id AND public.user_has_module_permission(auth.uid(), e.organization_id, 'sales', 'read')));
CREATE POLICY "estimate_items_insert_perm" ON public.estimate_items FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.estimates e WHERE e.id = estimate_items.estimate_id AND public.user_has_module_permission(auth.uid(), e.organization_id, 'sales', 'create')));
CREATE POLICY "estimate_items_update_perm" ON public.estimate_items FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.estimates e WHERE e.id = estimate_items.estimate_id AND public.user_has_module_permission(auth.uid(), e.organization_id, 'sales', 'write')));
CREATE POLICY "estimate_items_delete_perm" ON public.estimate_items FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.estimates e WHERE e.id = estimate_items.estimate_id AND public.user_has_module_permission(auth.uid(), e.organization_id, 'sales', 'delete')));

DROP POLICY IF EXISTS "Users can view credit notes in their organizations" ON public.credit_notes;
DROP POLICY IF EXISTS "Users can create credit notes in their organizations" ON public.credit_notes;
DROP POLICY IF EXISTS "Users can update credit notes in their organizations" ON public.credit_notes;
DROP POLICY IF EXISTS "Users can delete credit notes in their organizations" ON public.credit_notes;
DROP POLICY IF EXISTS "Admins can delete credit notes" ON public.credit_notes;

CREATE POLICY "credit_notes_select_perm" ON public.credit_notes FOR SELECT TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'sales', 'read'));
CREATE POLICY "credit_notes_insert_perm" ON public.credit_notes FOR INSERT TO authenticated
  WITH CHECK (public.user_has_module_permission(auth.uid(), organization_id, 'sales', 'create'));
CREATE POLICY "credit_notes_update_perm" ON public.credit_notes FOR UPDATE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'sales', 'write'));
CREATE POLICY "credit_notes_delete_perm" ON public.credit_notes FOR DELETE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'sales', 'delete'));

DROP POLICY IF EXISTS "Users can manage credit note items" ON public.credit_note_items;
DROP POLICY IF EXISTS "Users can view credit note items" ON public.credit_note_items;

CREATE POLICY "cn_items_select_perm" ON public.credit_note_items FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.credit_notes cn WHERE cn.id = credit_note_items.credit_note_id AND public.user_has_module_permission(auth.uid(), cn.organization_id, 'sales', 'read')));
CREATE POLICY "cn_items_insert_perm" ON public.credit_note_items FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.credit_notes cn WHERE cn.id = credit_note_items.credit_note_id AND public.user_has_module_permission(auth.uid(), cn.organization_id, 'sales', 'create')));
CREATE POLICY "cn_items_update_perm" ON public.credit_note_items FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.credit_notes cn WHERE cn.id = credit_note_items.credit_note_id AND public.user_has_module_permission(auth.uid(), cn.organization_id, 'sales', 'write')));
CREATE POLICY "cn_items_delete_perm" ON public.credit_note_items FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.credit_notes cn WHERE cn.id = credit_note_items.credit_note_id AND public.user_has_module_permission(auth.uid(), cn.organization_id, 'sales', 'delete')));

DROP POLICY IF EXISTS "Users can view delivery notes in their organizations" ON public.delivery_notes;
DROP POLICY IF EXISTS "Users can create delivery notes in their organizations" ON public.delivery_notes;
DROP POLICY IF EXISTS "Users can update delivery notes in their organizations" ON public.delivery_notes;
DROP POLICY IF EXISTS "Users can delete delivery notes in their organizations" ON public.delivery_notes;

CREATE POLICY "delivery_notes_select_perm" ON public.delivery_notes FOR SELECT TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'sales', 'read'));
CREATE POLICY "delivery_notes_insert_perm" ON public.delivery_notes FOR INSERT TO authenticated
  WITH CHECK (public.user_has_module_permission(auth.uid(), organization_id, 'sales', 'create'));
CREATE POLICY "delivery_notes_update_perm" ON public.delivery_notes FOR UPDATE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'sales', 'write'));
CREATE POLICY "delivery_notes_delete_perm" ON public.delivery_notes FOR DELETE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'sales', 'delete'));

DROP POLICY IF EXISTS "Users can manage delivery note items" ON public.delivery_note_items;
DROP POLICY IF EXISTS "Users can view delivery note items" ON public.delivery_note_items;

CREATE POLICY "dn_items_select_perm" ON public.delivery_note_items FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.delivery_notes dn WHERE dn.id = delivery_note_items.delivery_note_id AND public.user_has_module_permission(auth.uid(), dn.organization_id, 'sales', 'read')));
CREATE POLICY "dn_items_insert_perm" ON public.delivery_note_items FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.delivery_notes dn WHERE dn.id = delivery_note_items.delivery_note_id AND public.user_has_module_permission(auth.uid(), dn.organization_id, 'sales', 'create')));
CREATE POLICY "dn_items_update_perm" ON public.delivery_note_items FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.delivery_notes dn WHERE dn.id = delivery_note_items.delivery_note_id AND public.user_has_module_permission(auth.uid(), dn.organization_id, 'sales', 'write')));
CREATE POLICY "dn_items_delete_perm" ON public.delivery_note_items FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.delivery_notes dn WHERE dn.id = delivery_note_items.delivery_note_id AND public.user_has_module_permission(auth.uid(), dn.organization_id, 'sales', 'delete')));

DROP POLICY IF EXISTS "Users can view sales orders in their organizations" ON public.sales_orders;
DROP POLICY IF EXISTS "Users can create sales orders in their organizations" ON public.sales_orders;
DROP POLICY IF EXISTS "Users can update sales orders in their organizations" ON public.sales_orders;
DROP POLICY IF EXISTS "Users can delete sales orders in their organizations" ON public.sales_orders;
DROP POLICY IF EXISTS "Admins can delete sales orders" ON public.sales_orders;

CREATE POLICY "sales_orders_select_perm" ON public.sales_orders FOR SELECT TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'sales', 'read'));
CREATE POLICY "sales_orders_insert_perm" ON public.sales_orders FOR INSERT TO authenticated
  WITH CHECK (public.user_has_module_permission(auth.uid(), organization_id, 'sales', 'create'));
CREATE POLICY "sales_orders_update_perm" ON public.sales_orders FOR UPDATE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'sales', 'write'));
CREATE POLICY "sales_orders_delete_perm" ON public.sales_orders FOR DELETE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'sales', 'delete'));

DROP POLICY IF EXISTS "Users can manage sales order items" ON public.sales_order_items;
DROP POLICY IF EXISTS "Users can view sales order items" ON public.sales_order_items;
DROP POLICY IF EXISTS "Admins can delete sales order items" ON public.sales_order_items;

CREATE POLICY "so_items_select_perm" ON public.sales_order_items FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.sales_orders so WHERE so.id = sales_order_items.sales_order_id AND public.user_has_module_permission(auth.uid(), so.organization_id, 'sales', 'read')));
CREATE POLICY "so_items_insert_perm" ON public.sales_order_items FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.sales_orders so WHERE so.id = sales_order_items.sales_order_id AND public.user_has_module_permission(auth.uid(), so.organization_id, 'sales', 'create')));
CREATE POLICY "so_items_update_perm" ON public.sales_order_items FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.sales_orders so WHERE so.id = sales_order_items.sales_order_id AND public.user_has_module_permission(auth.uid(), so.organization_id, 'sales', 'write')));
CREATE POLICY "so_items_delete_perm" ON public.sales_order_items FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.sales_orders so WHERE so.id = sales_order_items.sales_order_id AND public.user_has_module_permission(auth.uid(), so.organization_id, 'sales', 'delete')));

DROP POLICY IF EXISTS "Users can view sales returns in their organizations" ON public.sales_returns;
DROP POLICY IF EXISTS "Users can create sales returns in their organizations" ON public.sales_returns;
DROP POLICY IF EXISTS "Users can update sales returns in their organizations" ON public.sales_returns;
DROP POLICY IF EXISTS "Users can delete sales returns in their organizations" ON public.sales_returns;

CREATE POLICY "sales_returns_select_perm" ON public.sales_returns FOR SELECT TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'sales', 'read'));
CREATE POLICY "sales_returns_insert_perm" ON public.sales_returns FOR INSERT TO authenticated
  WITH CHECK (public.user_has_module_permission(auth.uid(), organization_id, 'sales', 'create'));
CREATE POLICY "sales_returns_update_perm" ON public.sales_returns FOR UPDATE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'sales', 'write'));
CREATE POLICY "sales_returns_delete_perm" ON public.sales_returns FOR DELETE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'sales', 'delete'));

DROP POLICY IF EXISTS "Users can view proforma invoices in their organizations" ON public.proforma_invoices;
DROP POLICY IF EXISTS "Users can create proforma invoices in their organizations" ON public.proforma_invoices;
DROP POLICY IF EXISTS "Users can update proforma invoices in their organizations" ON public.proforma_invoices;
DROP POLICY IF EXISTS "Users can delete proforma invoices in their organizations" ON public.proforma_invoices;

CREATE POLICY "proforma_invoices_select_perm" ON public.proforma_invoices FOR SELECT TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'sales', 'read'));
CREATE POLICY "proforma_invoices_insert_perm" ON public.proforma_invoices FOR INSERT TO authenticated
  WITH CHECK (public.user_has_module_permission(auth.uid(), organization_id, 'sales', 'create'));
CREATE POLICY "proforma_invoices_update_perm" ON public.proforma_invoices FOR UPDATE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'sales', 'write'));
CREATE POLICY "proforma_invoices_delete_perm" ON public.proforma_invoices FOR DELETE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'sales', 'delete'));

DROP POLICY IF EXISTS "Users can view recurring invoices in their organizations" ON public.recurring_invoices;
DROP POLICY IF EXISTS "Users can create recurring invoices in their organizations" ON public.recurring_invoices;
DROP POLICY IF EXISTS "Users can update recurring invoices in their organizations" ON public.recurring_invoices;
DROP POLICY IF EXISTS "Users can delete recurring invoices in their organizations" ON public.recurring_invoices;

CREATE POLICY "recurring_invoices_select_perm" ON public.recurring_invoices FOR SELECT TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'sales', 'read'));
CREATE POLICY "recurring_invoices_insert_perm" ON public.recurring_invoices FOR INSERT TO authenticated
  WITH CHECK (public.user_has_module_permission(auth.uid(), organization_id, 'sales', 'create'));
CREATE POLICY "recurring_invoices_update_perm" ON public.recurring_invoices FOR UPDATE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'sales', 'write'));
CREATE POLICY "recurring_invoices_delete_perm" ON public.recurring_invoices FOR DELETE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'sales', 'delete'));

DROP POLICY IF EXISTS "Users can view payments in their organizations" ON public.payments;
DROP POLICY IF EXISTS "Users can create payments in their organizations" ON public.payments;
DROP POLICY IF EXISTS "Users can update payments in their organizations" ON public.payments;
DROP POLICY IF EXISTS "Users can delete payments in their organizations" ON public.payments;
DROP POLICY IF EXISTS "Admins can delete payments" ON public.payments;

CREATE POLICY "payments_select_perm" ON public.payments FOR SELECT TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'sales', 'read'));
CREATE POLICY "payments_insert_perm" ON public.payments FOR INSERT TO authenticated
  WITH CHECK (public.user_has_module_permission(auth.uid(), organization_id, 'sales', 'create'));
CREATE POLICY "payments_update_perm" ON public.payments FOR UPDATE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'sales', 'write'));
CREATE POLICY "payments_delete_perm" ON public.payments FOR DELETE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'sales', 'delete'));

DROP POLICY IF EXISTS "Users can view backorders in their organizations" ON public.backorders;
DROP POLICY IF EXISTS "Users can create backorders in their organizations" ON public.backorders;
DROP POLICY IF EXISTS "Users can update backorders in their organizations" ON public.backorders;
DROP POLICY IF EXISTS "Users can delete backorders in their organizations" ON public.backorders;
DROP POLICY IF EXISTS "org_backorders_select" ON public.backorders;
DROP POLICY IF EXISTS "org_backorders_insert" ON public.backorders;
DROP POLICY IF EXISTS "org_backorders_update" ON public.backorders;
DROP POLICY IF EXISTS "org_backorders_delete" ON public.backorders;

CREATE POLICY "backorders_select_perm" ON public.backorders FOR SELECT TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'sales', 'read'));
CREATE POLICY "backorders_insert_perm" ON public.backorders FOR INSERT TO authenticated
  WITH CHECK (public.user_has_module_permission(auth.uid(), organization_id, 'sales', 'create'));
CREATE POLICY "backorders_update_perm" ON public.backorders FOR UPDATE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'sales', 'write'));
CREATE POLICY "backorders_delete_perm" ON public.backorders FOR DELETE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'sales', 'delete'));

-- ===================== PURCHASES MODULE =====================

DROP POLICY IF EXISTS "Users can view bills in their organizations" ON public.bills;
DROP POLICY IF EXISTS "Users can create bills in their organizations" ON public.bills;
DROP POLICY IF EXISTS "Users can update bills in their organizations" ON public.bills;
DROP POLICY IF EXISTS "Users can delete bills in their organizations" ON public.bills;
DROP POLICY IF EXISTS "Admins can delete bills" ON public.bills;

CREATE POLICY "bills_select_perm" ON public.bills FOR SELECT TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'purchases', 'read'));
CREATE POLICY "bills_insert_perm" ON public.bills FOR INSERT TO authenticated
  WITH CHECK (public.user_has_module_permission(auth.uid(), organization_id, 'purchases', 'create'));
CREATE POLICY "bills_update_perm" ON public.bills FOR UPDATE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'purchases', 'write'));
CREATE POLICY "bills_delete_perm" ON public.bills FOR DELETE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'purchases', 'delete'));

DROP POLICY IF EXISTS "Users can manage bill items" ON public.bill_items;
DROP POLICY IF EXISTS "Users can view bill items" ON public.bill_items;
DROP POLICY IF EXISTS "Admins can delete bill items" ON public.bill_items;

CREATE POLICY "bill_items_select_perm" ON public.bill_items FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.bills b WHERE b.id = bill_items.bill_id AND public.user_has_module_permission(auth.uid(), b.organization_id, 'purchases', 'read')));
CREATE POLICY "bill_items_insert_perm" ON public.bill_items FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.bills b WHERE b.id = bill_items.bill_id AND public.user_has_module_permission(auth.uid(), b.organization_id, 'purchases', 'create')));
CREATE POLICY "bill_items_update_perm" ON public.bill_items FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.bills b WHERE b.id = bill_items.bill_id AND public.user_has_module_permission(auth.uid(), b.organization_id, 'purchases', 'write')));
CREATE POLICY "bill_items_delete_perm" ON public.bill_items FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.bills b WHERE b.id = bill_items.bill_id AND public.user_has_module_permission(auth.uid(), b.organization_id, 'purchases', 'delete')));

DROP POLICY IF EXISTS "Users can view bill payments in their organizations" ON public.bill_payments;
DROP POLICY IF EXISTS "Users can create bill payments in their organizations" ON public.bill_payments;
DROP POLICY IF EXISTS "Users can update bill payments in their organizations" ON public.bill_payments;
DROP POLICY IF EXISTS "Users can delete bill payments in their organizations" ON public.bill_payments;
DROP POLICY IF EXISTS "Admins can delete bill payments" ON public.bill_payments;

CREATE POLICY "bill_payments_select_perm" ON public.bill_payments FOR SELECT TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'purchases', 'read'));
CREATE POLICY "bill_payments_insert_perm" ON public.bill_payments FOR INSERT TO authenticated
  WITH CHECK (public.user_has_module_permission(auth.uid(), organization_id, 'purchases', 'create'));
CREATE POLICY "bill_payments_update_perm" ON public.bill_payments FOR UPDATE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'purchases', 'write'));
CREATE POLICY "bill_payments_delete_perm" ON public.bill_payments FOR DELETE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'purchases', 'delete'));

DROP POLICY IF EXISTS "Users can view purchase orders in their organizations" ON public.purchase_orders;
DROP POLICY IF EXISTS "Users can create purchase orders in their organizations" ON public.purchase_orders;
DROP POLICY IF EXISTS "Users can update purchase orders in their organizations" ON public.purchase_orders;
DROP POLICY IF EXISTS "Users can delete purchase orders in their organizations" ON public.purchase_orders;
DROP POLICY IF EXISTS "Admins can delete purchase orders" ON public.purchase_orders;

CREATE POLICY "po_select_perm" ON public.purchase_orders FOR SELECT TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'purchases', 'read'));
CREATE POLICY "po_insert_perm" ON public.purchase_orders FOR INSERT TO authenticated
  WITH CHECK (public.user_has_module_permission(auth.uid(), organization_id, 'purchases', 'create'));
CREATE POLICY "po_update_perm" ON public.purchase_orders FOR UPDATE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'purchases', 'write'));
CREATE POLICY "po_delete_perm" ON public.purchase_orders FOR DELETE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'purchases', 'delete'));

DROP POLICY IF EXISTS "Users can view purchase returns in their organizations" ON public.purchase_returns;
DROP POLICY IF EXISTS "Users can create purchase returns in their organizations" ON public.purchase_returns;
DROP POLICY IF EXISTS "Users can update purchase returns in their organizations" ON public.purchase_returns;
DROP POLICY IF EXISTS "Users can delete purchase returns in their organizations" ON public.purchase_returns;

CREATE POLICY "purchase_returns_select_perm" ON public.purchase_returns FOR SELECT TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'purchases', 'read'));
CREATE POLICY "purchase_returns_insert_perm" ON public.purchase_returns FOR INSERT TO authenticated
  WITH CHECK (public.user_has_module_permission(auth.uid(), organization_id, 'purchases', 'create'));
CREATE POLICY "purchase_returns_update_perm" ON public.purchase_returns FOR UPDATE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'purchases', 'write'));
CREATE POLICY "purchase_returns_delete_perm" ON public.purchase_returns FOR DELETE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'purchases', 'delete'));

DROP POLICY IF EXISTS "Users can view RFQs in their organizations" ON public.rfqs;
DROP POLICY IF EXISTS "Users can create RFQs in their organizations" ON public.rfqs;
DROP POLICY IF EXISTS "Users can update RFQs in their organizations" ON public.rfqs;
DROP POLICY IF EXISTS "Users can delete RFQs in their organizations" ON public.rfqs;

CREATE POLICY "rfqs_select_perm" ON public.rfqs FOR SELECT TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'purchases', 'read'));
CREATE POLICY "rfqs_insert_perm" ON public.rfqs FOR INSERT TO authenticated
  WITH CHECK (public.user_has_module_permission(auth.uid(), organization_id, 'purchases', 'create'));
CREATE POLICY "rfqs_update_perm" ON public.rfqs FOR UPDATE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'purchases', 'write'));
CREATE POLICY "rfqs_delete_perm" ON public.rfqs FOR DELETE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'purchases', 'delete'));

DROP POLICY IF EXISTS "Users can view expenses in their organizations" ON public.expenses;
DROP POLICY IF EXISTS "Users can create expenses in their organizations" ON public.expenses;
DROP POLICY IF EXISTS "Users can update expenses in their organizations" ON public.expenses;
DROP POLICY IF EXISTS "Users can delete expenses in their organizations" ON public.expenses;
DROP POLICY IF EXISTS "Admins can delete expenses" ON public.expenses;

CREATE POLICY "expenses_select_perm" ON public.expenses FOR SELECT TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'purchases', 'read'));
CREATE POLICY "expenses_insert_perm" ON public.expenses FOR INSERT TO authenticated
  WITH CHECK (public.user_has_module_permission(auth.uid(), organization_id, 'purchases', 'create'));
CREATE POLICY "expenses_update_perm" ON public.expenses FOR UPDATE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'purchases', 'write'));
CREATE POLICY "expenses_delete_perm" ON public.expenses FOR DELETE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'purchases', 'delete'));

-- ===================== FINANCIALS MODULE =====================

DROP POLICY IF EXISTS "Users can view accounts in their organizations" ON public.accounts;
DROP POLICY IF EXISTS "Users can create accounts in their organizations" ON public.accounts;
DROP POLICY IF EXISTS "Users can update accounts in their organizations" ON public.accounts;
DROP POLICY IF EXISTS "Users can delete non-system accounts" ON public.accounts;
DROP POLICY IF EXISTS "Admins can delete accounts" ON public.accounts;

CREATE POLICY "accounts_select_perm" ON public.accounts FOR SELECT TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'financials', 'read'));
CREATE POLICY "accounts_insert_perm" ON public.accounts FOR INSERT TO authenticated
  WITH CHECK (public.user_has_module_permission(auth.uid(), organization_id, 'financials', 'create'));
CREATE POLICY "accounts_update_perm" ON public.accounts FOR UPDATE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'financials', 'write'));
CREATE POLICY "accounts_delete_perm" ON public.accounts FOR DELETE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'financials', 'delete') AND is_system = false);

DROP POLICY IF EXISTS "Users can view journal entries in their organizations" ON public.journal_entries;
DROP POLICY IF EXISTS "Users can create journal entries in their organizations" ON public.journal_entries;
DROP POLICY IF EXISTS "Users can update journal entries in their organizations" ON public.journal_entries;
DROP POLICY IF EXISTS "Users can delete journal entries in their organizations" ON public.journal_entries;
DROP POLICY IF EXISTS "Admins can delete journal entries" ON public.journal_entries;

CREATE POLICY "je_select_perm" ON public.journal_entries FOR SELECT TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'financials', 'read'));
CREATE POLICY "je_insert_perm" ON public.journal_entries FOR INSERT TO authenticated
  WITH CHECK (public.user_has_module_permission(auth.uid(), organization_id, 'financials', 'create'));
CREATE POLICY "je_update_perm" ON public.journal_entries FOR UPDATE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'financials', 'write'));
CREATE POLICY "je_delete_perm" ON public.journal_entries FOR DELETE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'financials', 'delete'));

DROP POLICY IF EXISTS "Users can manage journal entry lines" ON public.journal_entry_lines;
DROP POLICY IF EXISTS "Users can view journal entry lines" ON public.journal_entry_lines;
DROP POLICY IF EXISTS "Admins can delete journal entry lines" ON public.journal_entry_lines;

CREATE POLICY "jel_select_perm" ON public.journal_entry_lines FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.journal_entries je WHERE je.id = journal_entry_lines.journal_entry_id AND public.user_has_module_permission(auth.uid(), je.organization_id, 'financials', 'read')));
CREATE POLICY "jel_insert_perm" ON public.journal_entry_lines FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.journal_entries je WHERE je.id = journal_entry_lines.journal_entry_id AND public.user_has_module_permission(auth.uid(), je.organization_id, 'financials', 'create')));
CREATE POLICY "jel_update_perm" ON public.journal_entry_lines FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.journal_entries je WHERE je.id = journal_entry_lines.journal_entry_id AND public.user_has_module_permission(auth.uid(), je.organization_id, 'financials', 'write')));
CREATE POLICY "jel_delete_perm" ON public.journal_entry_lines FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.journal_entries je WHERE je.id = journal_entry_lines.journal_entry_id AND public.user_has_module_permission(auth.uid(), je.organization_id, 'financials', 'delete')));

DROP POLICY IF EXISTS "Users can view bank accounts in their organizations" ON public.bank_accounts;
DROP POLICY IF EXISTS "Admins can manage bank accounts" ON public.bank_accounts;
DROP POLICY IF EXISTS "Admins can delete bank accounts" ON public.bank_accounts;

CREATE POLICY "bank_accounts_select_perm" ON public.bank_accounts FOR SELECT TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'financials', 'read'));
CREATE POLICY "bank_accounts_insert_perm" ON public.bank_accounts FOR INSERT TO authenticated
  WITH CHECK (public.user_has_module_permission(auth.uid(), organization_id, 'financials', 'create'));
CREATE POLICY "bank_accounts_update_perm" ON public.bank_accounts FOR UPDATE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'financials', 'write'));
CREATE POLICY "bank_accounts_delete_perm" ON public.bank_accounts FOR DELETE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'financials', 'delete'));

DROP POLICY IF EXISTS "Organization members can view bank transactions" ON public.bank_transactions;
DROP POLICY IF EXISTS "Organization members can insert bank transactions" ON public.bank_transactions;
DROP POLICY IF EXISTS "Organization members can update bank transactions" ON public.bank_transactions;
DROP POLICY IF EXISTS "Admins can delete bank transactions" ON public.bank_transactions;

CREATE POLICY "bank_txn_select_perm" ON public.bank_transactions FOR SELECT TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'financials', 'read'));
CREATE POLICY "bank_txn_insert_perm" ON public.bank_transactions FOR INSERT TO authenticated
  WITH CHECK (public.user_has_module_permission(auth.uid(), organization_id, 'financials', 'create'));
CREATE POLICY "bank_txn_update_perm" ON public.bank_transactions FOR UPDATE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'financials', 'write'));
CREATE POLICY "bank_txn_delete_perm" ON public.bank_transactions FOR DELETE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'financials', 'delete'));

DROP POLICY IF EXISTS "Users can view budgets in their organizations" ON public.budgets;
DROP POLICY IF EXISTS "Users can create budgets in their organizations" ON public.budgets;
DROP POLICY IF EXISTS "Users can update budgets in their organizations" ON public.budgets;
DROP POLICY IF EXISTS "Users can delete budgets in their organizations" ON public.budgets;
DROP POLICY IF EXISTS "Admins can delete budgets" ON public.budgets;

CREATE POLICY "budgets_select_perm" ON public.budgets FOR SELECT TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'financials', 'read'));
CREATE POLICY "budgets_insert_perm" ON public.budgets FOR INSERT TO authenticated
  WITH CHECK (public.user_has_module_permission(auth.uid(), organization_id, 'financials', 'create'));
CREATE POLICY "budgets_update_perm" ON public.budgets FOR UPDATE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'financials', 'write'));
CREATE POLICY "budgets_delete_perm" ON public.budgets FOR DELETE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'financials', 'delete'));

DROP POLICY IF EXISTS "Users can view fixed assets in their organizations" ON public.fixed_assets;
DROP POLICY IF EXISTS "Users can create fixed assets in their organizations" ON public.fixed_assets;
DROP POLICY IF EXISTS "Users can update fixed assets in their organizations" ON public.fixed_assets;
DROP POLICY IF EXISTS "Users can delete fixed assets in their organizations" ON public.fixed_assets;
DROP POLICY IF EXISTS "Admins can delete fixed assets" ON public.fixed_assets;

CREATE POLICY "fixed_assets_select_perm" ON public.fixed_assets FOR SELECT TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'financials', 'read'));
CREATE POLICY "fixed_assets_insert_perm" ON public.fixed_assets FOR INSERT TO authenticated
  WITH CHECK (public.user_has_module_permission(auth.uid(), organization_id, 'financials', 'create'));
CREATE POLICY "fixed_assets_update_perm" ON public.fixed_assets FOR UPDATE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'financials', 'write'));
CREATE POLICY "fixed_assets_delete_perm" ON public.fixed_assets FOR DELETE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'financials', 'delete'));

DROP POLICY IF EXISTS "Users can view fiscal periods in their organizations" ON public.fiscal_periods;
DROP POLICY IF EXISTS "Users can create fiscal periods in their organizations" ON public.fiscal_periods;
DROP POLICY IF EXISTS "Users can update fiscal periods in their organizations" ON public.fiscal_periods;
DROP POLICY IF EXISTS "Users can delete fiscal periods in their organizations" ON public.fiscal_periods;

CREATE POLICY "fiscal_periods_select_perm" ON public.fiscal_periods FOR SELECT TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'financials', 'read'));
CREATE POLICY "fiscal_periods_insert_perm" ON public.fiscal_periods FOR INSERT TO authenticated
  WITH CHECK (public.user_has_module_permission(auth.uid(), organization_id, 'financials', 'create'));
CREATE POLICY "fiscal_periods_update_perm" ON public.fiscal_periods FOR UPDATE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'financials', 'write'));
CREATE POLICY "fiscal_periods_delete_perm" ON public.fiscal_periods FOR DELETE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'financials', 'delete'));

-- ===================== HR MODULE (departments) =====================

DROP POLICY IF EXISTS "Users can view departments in their organizations" ON public.departments;
DROP POLICY IF EXISTS "Users can create departments in their organizations" ON public.departments;
DROP POLICY IF EXISTS "Users can update departments in their organizations" ON public.departments;
DROP POLICY IF EXISTS "Users can delete departments in their organizations" ON public.departments;
DROP POLICY IF EXISTS "org_departments_select" ON public.departments;
DROP POLICY IF EXISTS "org_departments_insert" ON public.departments;
DROP POLICY IF EXISTS "org_departments_update" ON public.departments;
DROP POLICY IF EXISTS "org_departments_delete" ON public.departments;

CREATE POLICY "departments_select_perm" ON public.departments FOR SELECT TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'hr', 'read'));
CREATE POLICY "departments_insert_perm" ON public.departments FOR INSERT TO authenticated
  WITH CHECK (public.user_has_module_permission(auth.uid(), organization_id, 'hr', 'create'));
CREATE POLICY "departments_update_perm" ON public.departments FOR UPDATE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'hr', 'write'));
CREATE POLICY "departments_delete_perm" ON public.departments FOR DELETE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'hr', 'delete'));

-- ===================== PAYROLL MODULE =====================

DROP POLICY IF EXISTS "Users can view payroll runs in their organizations" ON public.payroll_runs;
DROP POLICY IF EXISTS "Users can create payroll runs in their organizations" ON public.payroll_runs;
DROP POLICY IF EXISTS "Users can update payroll runs in their organizations" ON public.payroll_runs;
DROP POLICY IF EXISTS "Users can delete payroll runs in their organizations" ON public.payroll_runs;
DROP POLICY IF EXISTS "Admins can delete payroll runs" ON public.payroll_runs;
DROP POLICY IF EXISTS "org_payroll_runs_select" ON public.payroll_runs;
DROP POLICY IF EXISTS "org_payroll_runs_insert" ON public.payroll_runs;
DROP POLICY IF EXISTS "org_payroll_runs_update" ON public.payroll_runs;
DROP POLICY IF EXISTS "org_payroll_runs_delete" ON public.payroll_runs;

CREATE POLICY "payroll_runs_select_perm" ON public.payroll_runs FOR SELECT TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'payroll', 'read'));
CREATE POLICY "payroll_runs_insert_perm" ON public.payroll_runs FOR INSERT TO authenticated
  WITH CHECK (public.user_has_module_permission(auth.uid(), organization_id, 'payroll', 'create'));
CREATE POLICY "payroll_runs_update_perm" ON public.payroll_runs FOR UPDATE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'payroll', 'write'));
CREATE POLICY "payroll_runs_delete_perm" ON public.payroll_runs FOR DELETE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'payroll', 'delete'));

DROP POLICY IF EXISTS "Users can view payslips in their organizations" ON public.payslips;
DROP POLICY IF EXISTS "Users can create payslips in their organizations" ON public.payslips;
DROP POLICY IF EXISTS "Users can update payslips in their organizations" ON public.payslips;
DROP POLICY IF EXISTS "Users can delete payslips in their organizations" ON public.payslips;
DROP POLICY IF EXISTS "org_payslips_select" ON public.payslips;
DROP POLICY IF EXISTS "org_payslips_insert" ON public.payslips;
DROP POLICY IF EXISTS "org_payslips_update" ON public.payslips;
DROP POLICY IF EXISTS "org_payslips_delete" ON public.payslips;

CREATE POLICY "payslips_select_perm" ON public.payslips FOR SELECT TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'payroll', 'read'));
CREATE POLICY "payslips_insert_perm" ON public.payslips FOR INSERT TO authenticated
  WITH CHECK (public.user_has_module_permission(auth.uid(), organization_id, 'payroll', 'create'));
CREATE POLICY "payslips_update_perm" ON public.payslips FOR UPDATE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'payroll', 'write'));
CREATE POLICY "payslips_delete_perm" ON public.payslips FOR DELETE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'payroll', 'delete'));

-- ===================== POS MODULE =====================

DROP POLICY IF EXISTS "Users can view sessions in their organization" ON public.pos_sessions;
DROP POLICY IF EXISTS "Cashiers can create their own sessions" ON public.pos_sessions;
DROP POLICY IF EXISTS "Users can update sessions in their organization" ON public.pos_sessions;

CREATE POLICY "pos_sessions_select_perm" ON public.pos_sessions FOR SELECT TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'pos', 'read'));
CREATE POLICY "pos_sessions_insert_perm" ON public.pos_sessions FOR INSERT TO authenticated
  WITH CHECK (public.user_has_module_permission(auth.uid(), organization_id, 'pos', 'create'));
CREATE POLICY "pos_sessions_update_perm" ON public.pos_sessions FOR UPDATE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'pos', 'write'));

DROP POLICY IF EXISTS "Users can view cash movements in their organization" ON public.pos_cash_movements;
DROP POLICY IF EXISTS "Users can manage cash movements in their organization" ON public.pos_cash_movements;

CREATE POLICY "pos_cash_select_perm" ON public.pos_cash_movements FOR SELECT TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'pos', 'read'));
CREATE POLICY "pos_cash_insert_perm" ON public.pos_cash_movements FOR INSERT TO authenticated
  WITH CHECK (public.user_has_module_permission(auth.uid(), organization_id, 'pos', 'create'));
CREATE POLICY "pos_cash_update_perm" ON public.pos_cash_movements FOR UPDATE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'pos', 'write'));
CREATE POLICY "pos_cash_delete_perm" ON public.pos_cash_movements FOR DELETE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'pos', 'delete'));

DROP POLICY IF EXISTS "Users can view cashiers in their organization" ON public.pos_cashiers;
DROP POLICY IF EXISTS "Managers can create cashiers" ON public.pos_cashiers;
DROP POLICY IF EXISTS "Managers can update cashiers" ON public.pos_cashiers;
DROP POLICY IF EXISTS "Managers can delete cashiers" ON public.pos_cashiers;

CREATE POLICY "pos_cashiers_select_perm" ON public.pos_cashiers FOR SELECT TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'pos', 'read'));
CREATE POLICY "pos_cashiers_insert_perm" ON public.pos_cashiers FOR INSERT TO authenticated
  WITH CHECK (public.user_has_module_permission(auth.uid(), organization_id, 'pos', 'create'));
CREATE POLICY "pos_cashiers_update_perm" ON public.pos_cashiers FOR UPDATE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'pos', 'write'));
CREATE POLICY "pos_cashiers_delete_perm" ON public.pos_cashiers FOR DELETE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'pos', 'delete'));

DROP POLICY IF EXISTS "Users can view discounts in their organization" ON public.pos_discounts;
DROP POLICY IF EXISTS "Users can manage discounts in their organization" ON public.pos_discounts;

CREATE POLICY "pos_discounts_select_perm" ON public.pos_discounts FOR SELECT TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'pos', 'read'));
CREATE POLICY "pos_discounts_insert_perm" ON public.pos_discounts FOR INSERT TO authenticated
  WITH CHECK (public.user_has_module_permission(auth.uid(), organization_id, 'pos', 'create'));
CREATE POLICY "pos_discounts_update_perm" ON public.pos_discounts FOR UPDATE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'pos', 'write'));
CREATE POLICY "pos_discounts_delete_perm" ON public.pos_discounts FOR DELETE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'pos', 'delete'));

-- ===================== LEAVE MODULE =====================

DROP POLICY IF EXISTS "Users can view leave types in their organization" ON public.leave_types;
DROP POLICY IF EXISTS "Users can manage leave types in their organization" ON public.leave_types;

CREATE POLICY "leave_types_select_perm" ON public.leave_types FOR SELECT TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'leave', 'read'));
CREATE POLICY "leave_types_insert_perm" ON public.leave_types FOR INSERT TO authenticated
  WITH CHECK (public.user_has_module_permission(auth.uid(), organization_id, 'leave', 'create'));
CREATE POLICY "leave_types_update_perm" ON public.leave_types FOR UPDATE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'leave', 'write'));
CREATE POLICY "leave_types_delete_perm" ON public.leave_types FOR DELETE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'leave', 'delete'));

DROP POLICY IF EXISTS "Users can view own and team leave requests" ON public.leave_requests;
DROP POLICY IF EXISTS "Users can manage leave requests in their organization" ON public.leave_requests;
DROP POLICY IF EXISTS "Managers and HR can update leave requests" ON public.leave_requests;

CREATE POLICY "leave_requests_select_perm" ON public.leave_requests FOR SELECT TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'leave', 'read'));
CREATE POLICY "leave_requests_insert_perm" ON public.leave_requests FOR INSERT TO authenticated
  WITH CHECK (public.user_has_module_permission(auth.uid(), organization_id, 'leave', 'create'));
CREATE POLICY "leave_requests_update_perm" ON public.leave_requests FOR UPDATE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'leave', 'write'));
CREATE POLICY "leave_requests_delete_perm" ON public.leave_requests FOR DELETE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'leave', 'delete'));

DROP POLICY IF EXISTS "Users can view leave allocations in their organization" ON public.leave_allocations;
DROP POLICY IF EXISTS "Users can manage leave allocations in their organization" ON public.leave_allocations;

CREATE POLICY "leave_alloc_select_perm" ON public.leave_allocations FOR SELECT TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'leave', 'read'));
CREATE POLICY "leave_alloc_insert_perm" ON public.leave_allocations FOR INSERT TO authenticated
  WITH CHECK (public.user_has_module_permission(auth.uid(), organization_id, 'leave', 'create'));
CREATE POLICY "leave_alloc_update_perm" ON public.leave_allocations FOR UPDATE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'leave', 'write'));
CREATE POLICY "leave_alloc_delete_perm" ON public.leave_allocations FOR DELETE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'leave', 'delete'));

-- ===================== PROJECTS MODULE =====================

DROP POLICY IF EXISTS "Users can view projects in their organization" ON public.projects;
DROP POLICY IF EXISTS "Users can manage projects in their organization" ON public.projects;
DROP POLICY IF EXISTS "Admins can delete projects" ON public.projects;

CREATE POLICY "projects_select_perm" ON public.projects FOR SELECT TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'projects', 'read'));
CREATE POLICY "projects_insert_perm" ON public.projects FOR INSERT TO authenticated
  WITH CHECK (public.user_has_module_permission(auth.uid(), organization_id, 'projects', 'create'));
CREATE POLICY "projects_update_perm" ON public.projects FOR UPDATE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'projects', 'write'));
CREATE POLICY "projects_delete_perm" ON public.projects FOR DELETE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'projects', 'delete'));

DROP POLICY IF EXISTS "Users can view project tasks in their organization" ON public.project_tasks;
DROP POLICY IF EXISTS "Users can manage project tasks in their organization" ON public.project_tasks;

CREATE POLICY "project_tasks_select_perm" ON public.project_tasks FOR SELECT TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'projects', 'read'));
CREATE POLICY "project_tasks_insert_perm" ON public.project_tasks FOR INSERT TO authenticated
  WITH CHECK (public.user_has_module_permission(auth.uid(), organization_id, 'projects', 'create'));
CREATE POLICY "project_tasks_update_perm" ON public.project_tasks FOR UPDATE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'projects', 'write'));
CREATE POLICY "project_tasks_delete_perm" ON public.project_tasks FOR DELETE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'projects', 'delete'));

-- ===================== TEAM / AUDIT MODULE =====================

DROP POLICY IF EXISTS "Users can view audit logs in their organizations" ON public.audit_logs;
DROP POLICY IF EXISTS "Users can create audit logs" ON public.audit_logs;

CREATE POLICY "audit_logs_select_perm" ON public.audit_logs FOR SELECT TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'team', 'read'));
CREATE POLICY "audit_logs_insert_perm" ON public.audit_logs FOR INSERT TO authenticated
  WITH CHECK (organization_id = ANY(get_user_organization_ids()));
