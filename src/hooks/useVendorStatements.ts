import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { useBranch } from "@/contexts/BranchContext";
import { applyBranchFilter } from "@/lib/branchScope";
import { toast } from "sonner";
import { normalizeError } from "@/services/resilience";
import { expandToCommercialPartnerSet } from "@/lib/contactHierarchy";
import { fetchContactOpenItemAging } from "@/services/finance/openItems";
import type { AgingBuckets } from "@/services/finance/aging";


// "Day before YYYY-MM-DD" as YYYY-MM-DD — used to scope prior-period
// rows when computing the opening balance from the canonical
// `vendor_ledger_entries` view.
function _isoBefore(d: string): string {
  const dt = new Date(d);
  dt.setDate(dt.getDate() - 1);
  return dt.toISOString().split('T')[0];
}

export interface VendorStatement {
  id: string;
  organization_id: string;
  contact_id: string;
  statement_date: string;
  period_start: string;
  period_end: string;
  opening_balance: number;
  total_billed: number;
  total_payments: number;
  closing_balance: number;
  sent_at: string | null;
  sent_to: string | null;
  pdf_url: string | null;
  created_by: string | null;
  created_at: string;
  contacts?: {
    id: string;
    name: string;
    email: string | null;
    company: string | null;
  };
}

export interface VendorStatementData {
  /** Issuing legal entity for branding (logo / address / tax ID). */
  business_id: string;
  branch_id: string | null;
  contact: {
    id: string;
    name: string;
    email: string | null;
    company: string | null;
    tax_id: string | null;
    address_line1: string | null;
    city: string | null;
    state: string | null;
    postal_code: string | null;
    country: string | null;
  };
  periodStart: string;
  periodEnd: string;
  openingBalance: number;
  transactions: {
    date: string;
    type: 'bill' | 'payment' | 'vendor_credit_note';
    reference: string;
    description: string;
    debit: number;
    credit: number;
    balance: number;
    sourceId?: string;
  }[];
  closingBalance: number;
  agingBuckets: AgingBuckets;

}

export interface GenerateVendorStatementInput {
  contact_id: string;
  period_start: string;
  period_end: string;
  /**
   * Phase F (Odoo-grade): when true, aggregate transactions across all
   * contacts that share the same `commercial_partner_id` (parent + children).
   */
  consolidate?: boolean;
}

export function useVendorStatements() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranch();
  const queryClient = useQueryClient();
  const organizationId = currentOrg?.id;
  const branchId = currentBranch?.id ?? null;

  // Fetch statement history
  const { data: statements = [], isLoading } = useQuery({
    queryKey: ["vendor-statements", organizationId, currentBusiness?.id, branchId],
    queryFn: async () => {
      if (!organizationId || !currentBusiness) return [];
      let q = supabase
        .from("vendor_statements")
        .select(`
          *,
          contacts(id, name, email, parent:contacts!parent_contact_id(name))
        `)
        .eq("organization_id", organizationId)
        .eq("business_id", currentBusiness.id)
        .order("statement_date", { ascending: false });
      q = applyBranchFilter(q, branchId);
      const { data, error } = await q;

      if (error) throw error;
      return (data ?? []).map((row: any) => ({
        ...row,
        contacts: row.contacts
          ? { ...row.contacts, company: row.contacts.parent?.name ?? null }
          : row.contacts,
      })) as VendorStatement[];
    },
    enabled: !!organizationId && !!currentBusiness,
  });

  // Generate statement data for a vendor
  const generateStatementData = async (input: GenerateVendorStatementInput): Promise<VendorStatementData> => {
    if (!organizationId) throw new Error("No organization selected");
    if (!currentBusiness?.id) throw new Error("No business selected");

    // Get contact info
    const { data: contactRaw, error: contactError } = await supabase
      .from("contacts")
      .select("*, parent:contacts!parent_contact_id(name)")
      .eq("id", input.contact_id)
      .eq("organization_id", organizationId)
      .eq("business_id", currentBusiness.id)
      .single();

    if (contactError) throw contactError;
    const contact: any = { ...contactRaw, company: (contactRaw as any)?.parent?.name ?? null };

    // Phase 7: rollup rule lives in `@/lib/contactHierarchy` — same helper
    // the AR side calls — so a single change point governs every read that
    // wants to aggregate sub-contacts to the commercial partner.
    const vendorIds: string[] = input.consolidate
      ? await expandToCommercialPartnerSet(input.contact_id, {
          organizationId,
          businessId: currentBusiness.id,
        })
      : [input.contact_id];

    // ADR 0028 / 0132 — one engine. The ledger read and the fold are the
    // SAME code the vendor-statement PDF, CSV and email use
    // (`vendorStatementLedger.ts` + `vendorStatementDataset.ts`), so the
    // screen and the exported document cannot disagree. The view unions
    // bills (credit / "we owe"), bill-payment allocations (debit / paid),
    // vendor credit notes and advances — so multi-bill payments resolve
    // correctly instead of falling back to the per-bill FK shape. Sign
    // conversion (GL → statement) happens inside the shared builder.
    const rows = await fetchVendorLedgerRows(supabase as any, {
      organizationId,
      businessId: currentBusiness.id,
      branchId,
      contactIds: vendorIds,
      periodEnd: input.period_end,
    });

    const dataset = buildVendorStatementDataset({
      rows,
      periodStart: input.period_start,
      periodEnd: input.period_end,
      currency: (currentBusiness as any)?.base_currency ?? null,
    });

    const openingBalance = dataset.openingBalance;
    const runningBalance = dataset.closingBalance;
    const transactions: VendorStatementData['transactions'] = dataset.transactions.map((t) => ({
      date: t.date,
      type: t.type,
      reference: t.reference,
      description: t.description,
      debit: t.debit,
      credit: t.credit,
      balance: t.balance,
      sourceId: t.sourceId,
    }));

    // ----- Aging buckets (canonical) -----
    // ADR 0027: read from the GL-anchored `finance_ap_open_items` projection
    // through the one shared helper instead of recomputing from
    // `bills.total - amount_paid`, so vendor statements agree with Aged
    // Payables and `get_ap_aging_summary`.
    const agingBuckets = await fetchContactOpenItemAging("ap", {
      orgId: organizationId,
      contactId: vendorIds,
      businessId: currentBusiness.id,
      branchId,
      // Age as of the statement period end, not the browser clock.
      asOf: input.period_end,
    });


    return {
      business_id: currentBusiness!.id,
      branch_id: branchId,
      contact: {
        id: contact.id,
        name: contact.name,
        email: contact.email,
        company: contact.company,
        tax_id: contact.tax_id || null,
        address_line1: contact.address_line1,
        city: contact.city,
        state: contact.state,
        postal_code: contact.postal_code,
        country: contact.country,
      },
      periodStart: input.period_start,
      periodEnd: input.period_end,
      openingBalance,
      transactions,
      closingBalance: runningBalance,
      agingBuckets,
    };
  };

  // Save statement record
  const saveStatement = useMutation({
    mutationFn: async (data: VendorStatementData) => {
      if (!organizationId) throw new Error("No organization selected");
      if (!currentBusiness?.id) throw new Error("No business selected");

      const { data: userData } = await supabase.auth.getUser();

      const { data: statement, error } = await supabase
        .from("vendor_statements")
        .insert({
          organization_id: organizationId,
          business_id: currentBusiness.id,
          // Stamp branch from active context — keeps statement scoped per branch.
          branch_id: data.branch_id ?? branchId,
          contact_id: data.contact.id,
          statement_date: new Date().toISOString().split('T')[0],
          period_start: data.periodStart,
          period_end: data.periodEnd,
          opening_balance: data.openingBalance,
          total_billed: data.transactions
            .filter(t => t.type === 'bill')
            .reduce((sum, t) => sum + t.debit, 0),
          total_payments: data.transactions
            .filter(t => t.type === 'payment' || t.type === 'vendor_credit_note')
            .reduce((sum, t) => sum + t.credit, 0),
          closing_balance: data.closingBalance,
          created_by: userData?.user?.id,
        } as any)
        .select()
        .single();

      if (error) throw error;
      return statement;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["vendor-statements"] });
      toast.success("Vendor statement saved");
    },
    onError: (error) => {
      toast.error("Failed to save statement: " + normalizeError(error).message);
    },
  });

  // Delete statement record
  const deleteStatement = useMutation({
    mutationFn: async (statementId: string) => {
      const { error } = await supabase
        .from("vendor_statements")
        .delete()
        .eq("id", statementId);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["vendor-statements"] });
      toast.success("Statement deleted");
    },
    onError: (error) => {
      toast.error("Failed to delete statement: " + normalizeError(error).message);
    },
  });

  return {
    statements,
    isLoading,
    generateStatementData,
    saveStatement,
    deleteStatement,
  };
}
