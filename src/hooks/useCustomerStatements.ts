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


export interface CustomerStatement {
  id: string;
  organization_id: string;
  contact_id: string;
  statement_date: string;
  period_start: string;
  period_end: string;
  opening_balance: number;
  total_invoiced: number;
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

export interface CustomerStatementData {
  /**
   * Issuing legal entity (and optional branch) for branding.
   * Statements MUST render with the issuing business's logo / address /
   * tax ID — not whatever business the user happens to have selected
   * when previewing. Branch is included so a branch-overridden logo
   * also flows through correctly.
   */
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
    type: 'invoice' | 'payment' | 'credit_note';
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

export interface GenerateStatementInput {
  contact_id: string;
  period_start: string;
  period_end: string;
  /**
   * Phase F (Odoo-grade): when true, aggregate transactions across all
   * contacts that share the same `commercial_partner_id` (i.e. the entire
   * parent + child family). Defaults to false for backward compatibility.
   */
  consolidate?: boolean;
}

export function useCustomerStatements() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranch();
  const queryClient = useQueryClient();
  const organizationId = currentOrg?.id;
  const branchId = currentBranch?.id ?? null;

  // Fetch statement history
  const { data: statements = [], isLoading } = useQuery({
    queryKey: ["customer-statements", organizationId, currentBusiness?.id, branchId],
    queryFn: async () => {
      if (!organizationId || !currentBusiness) return [];
      let q = supabase
        .from("customer_statements")
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
      })) as CustomerStatement[];
    },
    enabled: !!organizationId && !!currentBusiness,
  });

  // Generate statement data for a customer — ADR 0027.
  //
  // SOURCE OF TRUTH: `customer_ledger_entries` (unions invoices, payment
  // allocations, customer deposits, credit notes, refunds). Opening
  // balance, in-period transactions, and closing balance all derive from
  // this view so multi-invoice payments, reallocations, partial
  // applications, and advance cash all stay consistent with the customer
  // ledger page and aging report.
  //
  // Aging buckets continue to consult `invoices` + unapplied credit (CNs
  // + advance payments) because the view doesn't yet emit per-invoice
  // residual + due-date pairs. That math is unchanged from the prior
  // implementation.
  const generateStatementData = async (input: GenerateStatementInput): Promise<CustomerStatementData> => {
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

    // Phase 7: rollup rule lives in `@/lib/contactHierarchy` so the AR / AP
    // / dunning / credit consumers share one implementation. Posting is
    // unaffected — only this *read* widens to the parent + children family.
    const contactIds: string[] = input.consolidate
      ? await expandToCommercialPartnerSet(input.contact_id, {
          organizationId,
          businessId: currentBusiness.id,
        })
      : [input.contact_id];

    // ----- Ledger entries (canonical) -----
    // Pull every entry from the start of time through period_end for the
    // contact family. We split into "prior" (date < period_start) for the
    // opening balance and "in period" for the rendered transactions.
    let ledgerQ = (supabase as any)
      .from("customer_ledger_entries")
      .select("*")
      .eq("business_id", currentBusiness.id)
      .in("contact_id", contactIds)
      .lte("entry_date", input.period_end)
      .order("entry_date", { ascending: true })
      .order("created_at", { ascending: true });
    if (branchId) ledgerQ = ledgerQ.eq("branch_id", branchId);
    const { data: ledgerRows, error: ledgerError } = await ledgerQ;
    if (ledgerError) throw ledgerError;

    const allRows = (ledgerRows ?? []) as Array<{
      entry_date: string;
      doc_type: 'invoice' | 'payment' | 'deposit' | 'credit_note' | 'refund';
      doc_id: string;
      doc_ref: string;
      debit: number | string;
      credit: number | string;
    }>;

    const periodStartTs = new Date(input.period_start).getTime();

    let openingBalance = 0;
    for (const r of allRows) {
      if (new Date(r.entry_date).getTime() < periodStartTs) {
        openingBalance += (Number(r.debit) || 0) - (Number(r.credit) || 0);
      }
    }

    // Map ledger doc_type -> the statement UI's narrower 'invoice' |
    // 'payment' | 'credit_note' union. Deposits (advance customer cash)
    // and refunds (cash out) both render as 'payment' with a descriptive
    // label so the existing UI keeps working without a type extension.
    const mapType = (d: string): 'invoice' | 'payment' | 'credit_note' => {
      if (d === 'invoice') return 'invoice';
      if (d === 'credit_note') return 'credit_note';
      return 'payment'; // payment | deposit | refund
    };
    const describe = (d: string, ref: string): string => {
      switch (d) {
        case 'invoice': return `Invoice ${ref}`;
        case 'credit_note': return `Credit note ${ref}`;
        case 'deposit': return `Customer deposit ${ref}`.trim();
        case 'refund': return `Refund ${ref}`.trim();
        default: return `Payment ${ref}`.trim();
      }
    };

    const transactions: CustomerStatementData['transactions'] = [];
    let runningBalance = openingBalance;
    for (const r of allRows) {
      const ts = new Date(r.entry_date).getTime();
      if (ts < periodStartTs) continue;
      const debit = Number(r.debit) || 0;
      const credit = Number(r.credit) || 0;
      runningBalance += debit - credit;
      transactions.push({
        date: r.entry_date,
        type: mapType(r.doc_type),
        reference: r.doc_ref,
        description: describe(r.doc_type, r.doc_ref),
        debit,
        credit,
        balance: runningBalance,
        sourceId: r.doc_id,
      });
    }

    // ----- Aging buckets (canonical) -----
    // ADR 0027: aging is read from the GL-anchored open-items projection
    // (`finance_ar_open_items`) via the ONE shared helper, never recomputed
    // from `invoices.total - amount_paid`. The helper also nets unapplied
    // customer credit (`customer_credit_balances`), so the statement's aging
    // block agrees with the AR aging report, the Collections workspace and
    // `get_ar_summary` by construction.
    const agingBuckets = await fetchContactOpenItemAging("ar", {
      orgId: organizationId,
      contactId: contactIds,
      businessId: currentBusiness.id,
      branchId,
      // Age as of the statement period end, never the browser clock, so a
      // reprint of a closed period reproduces the original buckets.
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


  // Save statement record.
  //
  // Idempotent by (business, branch, contact, period): the server writer
  // `upsert_customer_statement_atomic` owns the row, backed by a unique
  // index. A double click, two tabs, or a retried bulk run refresh the same
  // snapshot instead of creating duplicate statements (and duplicate sends).
  const saveStatement = useMutation({
    mutationFn: async (data: CustomerStatementData) => {
      if (!organizationId) throw new Error("No organization selected");
      if (!currentBusiness?.id) throw new Error("No business selected");

      const { data: statement, error } = await (supabase as any).rpc(
        "upsert_customer_statement_atomic",
        {
          _payload: {
            organization_id: organizationId,
            business_id: currentBusiness.id,
            // Phase 5: stamp branch on the audit row so a branch user's
            // saved statements never bleed into HQ / sibling-branch lists.
            branch_id: data.branch_id ?? branchId ?? null,
            contact_id: data.contact.id,
            statement_date: new Date().toISOString().split('T')[0],
            period_start: data.periodStart,
            period_end: data.periodEnd,
            opening_balance: data.openingBalance,
            total_invoiced: data.transactions
              .filter(t => t.type === 'invoice')
              .reduce((sum, t) => sum + t.debit, 0),
            total_payments: data.transactions
              .filter(t => t.type === 'payment' || t.type === 'credit_note')
              .reduce((sum, t) => sum + t.credit, 0),
            closing_balance: data.closingBalance,
          },
        },
      );

      if (error) throw error;
      return statement as CustomerStatement;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["customer-statements"] });
      toast.success("Statement saved");
    },
    onError: (error) => {
      toast.error("Failed to save statement: " + normalizeError(error).message);
    },
  });

  // Delete statement record
  const deleteStatement = useMutation({
    mutationFn: async (statementId: string) => {
      const { error } = await supabase
        .from("customer_statements")
        .delete()
        .eq("id", statementId);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["customer-statements"] });
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
