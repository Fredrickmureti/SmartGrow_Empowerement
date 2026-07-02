/**
 * useContactProfile - Aggregation hook for 360-degree contact view
 * 
 * Fetches data across CRM, Sales, Purchases, and Finance modules
 * for a single contact to power the unified contact profile page.
 * 
 * Uses server-side filtered queries (not client-side filtering of all records)
 * for scalability with large datasets.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { type Contact } from "@/hooks/useContactsPaginated";
import { useMemo } from "react";
import { deriveInvoiceFromAllocations } from "@/lib/payments/deriveInvoiceFromAllocations";

export interface ContactProfileData {
  contact: Contact | null;
  // Financial KPIs
  outstandingReceivable: number;
  outstandingPayable: number;
  totalRevenue: number;
  totalPurchases: number;
  totalCreditAvailable: number;
  // CRM
  crmLeads: any[];
  openOpportunities: number;
  // Sales
  invoices: any[];
  salesOrders: any[];
  estimates: any[];
  // Purchases
  bills: any[];
  purchaseOrders: any[];
  // Payments
  payments: any[];
  billPayments: any[];
  // Credits
  creditNotes: any[];
  // Loading
  isLoading: boolean;
}

export function useContactProfile(contactId: string | null) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();

  // Contact 360° must be strictly company-scoped — never fall back to org-only
  // or we leak sister-company invoices/bills/payments/credits/leads into the
  // profile view. If business is momentarily unset, gate the whole hook off.
  const enabled = !!contactId && !!currentOrg?.id && !!currentBusiness?.id;

  // Fetch the contact itself
  const { data: contact = null, isLoading: contactLoading } = useQuery({
    queryKey: ["contact-profile", contactId, currentOrg?.id],
    queryFn: async () => {
      if (!contactId || !currentOrg?.id || !currentBusiness?.id) return null;
      const { data, error } = await supabase
        .from("contacts")
        .select("*")
        .eq("id", contactId)
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .single();
      if (error) return null;
      return data as unknown as Contact;
    },
    enabled,
  });

  // Invoices for this contact (server-side filtered)
  const { data: contactInvoices = [], isLoading: invoicesLoading } = useQuery({
    queryKey: ["contact-invoices", contactId, currentOrg?.id, currentBusiness?.id],
    queryFn: async () => {
      if (!contactId || !currentOrg?.id || !currentBusiness?.id) return [];
      const { data, error } = await supabase
        .from("invoices")
        .select("*")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .eq("contact_id", contactId)
        .order("issue_date", { ascending: false });
      if (error) return [];
      return data || [];
    },
    enabled,
  });

  // Bills for this contact (server-side filtered)
  const { data: contactBills = [], isLoading: billsLoading } = useQuery({
    queryKey: ["contact-bills", contactId, currentOrg?.id, currentBusiness?.id],
    queryFn: async () => {
      if (!contactId || !currentOrg?.id || !currentBusiness?.id) return [];
      const { data, error } = await supabase
        .from("bills")
        .select("*")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .eq("vendor_id", contactId)
        .order("bill_date", { ascending: false });
      if (error) return [];
      return data || [];
    },
    enabled,
  });

  // Credit Notes for this contact (server-side filtered)
  const { data: contactCredits = [], isLoading: creditsLoading } = useQuery({
    queryKey: ["contact-credit-notes", contactId, currentOrg?.id, currentBusiness?.id],
    queryFn: async () => {
      if (!contactId || !currentOrg?.id || !currentBusiness?.id) return [];
      const { data, error } = await supabase
        .from("credit_notes")
        .select("*")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .eq("contact_id", contactId)
        .not("status", "in", '("void","draft")')
        .order("issue_date", { ascending: false });
      if (error) return [];
      return data || [];
    },
    enabled,
  });

  // CRM Leads for this contact
  const { data: crmLeads = [], isLoading: leadsLoading } = useQuery({
    queryKey: ["contact-crm-leads", contactId, currentOrg?.id],
    queryFn: async () => {
      if (!contactId || !currentOrg?.id || !currentBusiness?.id) return [];
      const { data, error } = await supabase
        .from("crm_leads")
        .select("*, stage:crm_stages(id, name, color, is_won, is_lost)")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .eq("contact_id", contactId)
        .eq("is_active", true)
        .order("created_at", { ascending: false });
      if (error) return [];
      return data || [];
    },
    enabled,
  });

  // Sales Orders for this contact
  const { data: salesOrders = [], isLoading: salesOrdersLoading } = useQuery({
    queryKey: ["contact-sales-orders", contactId, currentOrg?.id],
    queryFn: async () => {
      if (!contactId || !currentOrg?.id || !currentBusiness?.id) return [];
      const { data, error } = await supabase
        .from("sales_orders")
        .select("*")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .eq("contact_id", contactId)
        .order("order_date", { ascending: false });
      if (error) return [];
      return data || [];
    },
    enabled,
  });

  // Estimates for this contact
  const { data: estimates = [], isLoading: estimatesLoading } = useQuery({
    queryKey: ["contact-estimates", contactId, currentOrg?.id, currentBusiness?.id],
    queryFn: async () => {
      if (!contactId || !currentOrg?.id || !currentBusiness?.id) return [];
      const { data, error } = await supabase
        .from("estimates")
        .select("*")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .eq("contact_id", contactId)
        .order("issue_date", { ascending: false });
      if (error) return [];
      return data || [];
    },
    enabled,
  });

  // Purchase Orders for this contact
  const { data: purchaseOrders = [], isLoading: poLoading } = useQuery({
    queryKey: ["contact-purchase-orders", contactId, currentOrg?.id],
    queryFn: async () => {
      if (!contactId || !currentOrg?.id || !currentBusiness?.id) return [];
      const { data, error } = await supabase
        .from("purchase_orders")
        .select("*")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .eq("vendor_id", contactId)
        .order("order_date", { ascending: false });
      if (error) return [];
      return data || [];
    },
    enabled,
  });

  // Payments for this contact
  const { data: payments = [], isLoading: paymentsLoading } = useQuery({
    queryKey: ["contact-payments-profile", contactId, currentOrg?.id],
    queryFn: async () => {
      if (!contactId || !currentOrg?.id || !currentBusiness?.id) return [];
      const { data, error } = await supabase
        .from("payments")
        .select("*, payment_allocations(amount, invoice:invoices(id, invoice_number, total))")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .eq("contact_id", contactId)
        .order("payment_date", { ascending: false });
      if (error) return [];
      // ADR 0027 — derive legacy `invoice` shape from allocations.
      return (data || []).map((p: any) => ({
        ...p,
        invoice: deriveInvoiceFromAllocations(p.payment_allocations),
      }));
    },
    enabled,
  });

  // Bill Payments for this vendor — allocation-sourced (ADR 0028).
  // Returns one row per allocation that touched a bill of this vendor.
  const { data: billPayments = [], isLoading: billPaymentsLoading } = useQuery({
    queryKey: ["contact-bill-payments", contactId, currentOrg?.id, currentBusiness?.id],
    queryFn: async () => {
      if (!contactId || !currentOrg?.id || !currentBusiness?.id) return [];
      const billIds = contactBills.map((b: any) => b.id);
      if (billIds.length === 0) return [];
      const { data, error } = await supabase
        .from("bill_payment_allocations")
        .select(`
          amount,
          bill:bills(id, bill_number),
          bill_payment:bill_payments(
            id, organization_id, business_id, branch_id, payment_date,
            amount, payment_method, reference, notes, journal_entry_id, created_at
          )
        `)
        .in("bill_id", billIds);
      if (error) return [];
      // Shape: per-allocation rows, exposed with `amount` = per-bill share.
      return (data || [])
        .filter((r: any) => r.bill_payment)
        .map((r: any) => ({
          ...r.bill_payment,
          amount: Number(r.amount),
          total_payment_amount: Number(r.bill_payment.amount),
          bill: r.bill,
        }))
        .sort((a: any, b: any) => (a.payment_date < b.payment_date ? 1 : -1));
    },
    enabled: enabled && !billsLoading && contactBills.length > 0,
  });

  // KPI calculations
  const outstandingReceivable = useMemo(() =>
    contactInvoices
      .filter((inv: any) => inv.status !== "paid" && inv.status !== "cancelled" && inv.status !== "draft")
      .reduce((sum: number, inv: any) => sum + ((inv.total || 0) - (inv.amount_paid || 0)), 0),
    [contactInvoices]
  );

  const outstandingPayable = useMemo(() =>
    contactBills
      .filter((bill: any) => bill.status !== "paid" && bill.status !== "void")
      .reduce((sum: number, bill: any) => sum + ((bill.total || 0) - (bill.amount_paid || 0)), 0),
    [contactBills]
  );

  const totalRevenue = useMemo(() =>
    contactInvoices.reduce((sum: number, inv: any) => sum + (inv.total || 0), 0),
    [contactInvoices]
  );

  const totalPurchases = useMemo(() =>
    contactBills.reduce((sum: number, bill: any) => sum + (bill.total || 0), 0),
    [contactBills]
  );

  const totalCreditAvailable = useMemo(() =>
    contactCredits.reduce((sum: number, cn: any) => sum + ((cn.total || cn.amount || 0) - (cn.amount_applied || 0)), 0),
    [contactCredits]
  );

  const openOpportunities = useMemo(() =>
    crmLeads.filter((l: any) => !l.won_at && !l.lost_at).length,
    [crmLeads]
  );

  const isLoading = contactLoading || invoicesLoading || billsLoading || creditsLoading ||
    leadsLoading || salesOrdersLoading || estimatesLoading || poLoading || paymentsLoading || billPaymentsLoading;

  return {
    contact,
    outstandingReceivable,
    outstandingPayable,
    totalRevenue,
    totalPurchases,
    totalCreditAvailable,
    crmLeads,
    openOpportunities,
    invoices: contactInvoices,
    salesOrders,
    estimates,
    bills: contactBills,
    purchaseOrders,
    payments,
    billPayments,
    creditNotes: contactCredits,
    isLoading,
  };
}
