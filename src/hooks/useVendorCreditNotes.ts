import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { useBranch } from "@/contexts/BranchContext";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "./use-toast";
import { useAuditLog } from "./useAuditLog";
import { usePermissions } from "./usePermissions";
import { assertCompanyScoped, assertBranchScoped } from "@/lib/purchases/scopingAssertions";
import { applyBranchFilter } from "@/lib/branchScope";

/** ADR 0132 Phase 2 — where a vendor credit economically comes from. */
export type VendorCreditOrigin =
  | "purchase_return"
  | "overbilling"
  | "price_correction"
  | "quantity_discrepancy"
  | "damaged_goods"
  | "rejected_goods"
  | "tax_correction"
  | "rebate"
  | "supplier_credit"
  | "adjustment";

export interface VendorCreditNoteItem {
  id?: string;
  credit_note_id?: string;
  product_id: string | null;
  account_id: string | null;
  description: string;
  quantity: number;
  unit_price: number;
  tax_rate: number;
  tax_amount: number;
  line_total: number;
  sort_order: number;
  /**
   * Line provenance. When set, the server recomputes price/tax from the bill
   * line and enforces the credit ceiling; client money on that line is ignored.
   */
  bill_item_id?: string | null;
  source_unit_price?: number | null;
  source_tax_rate?: number | null;
  // Multi-Unit provenance (added by migration). Forwarded through `...item`
  // spread in createVendorCreditNote so the BEFORE-trigger `_uom_normalize_line`
  // can stamp qty_in_base_uom / uom_snapshot server-side.
  packaging_id?: string | null;
  display_uom_id?: string | null;
  display_quantity?: number | null;
  uom_snapshot?: string | null;
}

/** Header lineage accepted by the create/update writers. */
export interface VendorCreditNoteLineage {
  origin?: VendorCreditOrigin;
  reason_code?: string | null;
  source_return_id?: string | null;
  goods_receipt_id?: string | null;
  purchase_order_id?: string | null;
  vendor_document_number?: string | null;
  vendor_document_date?: string | null;
  exchange_rate?: number | null;
  exchange_rate_date?: string | null;
}

export interface VendorCreditNote {
  id: string;
  organization_id: string;
  business_id: string | null;
  branch_id: string | null;
  credit_note_number: string;
  vendor_id: string | null;
  bill_id: string | null;
  status: "draft" | "confirmed" | "applied" | "void";
  credit_date: string;
  subtotal: number;
  tax_amount: number;
  total: number;
  amount_applied: number;
  currency: string;
  notes: string | null;
  journal_entry_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  origin?: VendorCreditOrigin;
  reason_code?: string | null;
  source_return_id?: string | null;
  goods_receipt_id?: string | null;
  purchase_order_id?: string | null;
  vendor_document_number?: string | null;
  vendor_document_date?: string | null;
  row_version?: number;
  vendor?: { name: string } | null;
  bill?: { bill_number: string } | null;
  items?: VendorCreditNoteItem[];
}


export function useVendorCreditNotes() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranch();
  const { user } = useAuth();
  const { toast } = useToast();
  const { logAction } = useAuditLog();
  const { can } = usePermissions();
  const [creditNotes, setCreditNotes] = useState<VendorCreditNote[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchCreditNotes = useCallback(async () => {
    if (!currentOrg || !currentBusiness) {
      setCreditNotes([]);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    let q = supabase
      .from("vendor_credit_notes")
      .select("*, vendor:contacts(name), bill:bills(bill_number), items:vendor_credit_note_items(*)")
      .eq("organization_id", currentOrg.id)
      .eq("business_id", currentBusiness.id)
      .order("created_at", { ascending: false });
    q = applyBranchFilter(q, currentBranch?.id ?? null);
    const { data, error } = await q;

    if (error) {
      console.error("Error fetching vendor credit notes:", error);
      setCreditNotes([]);
    } else {
      const rows = (data as unknown as VendorCreditNote[]) || [];
      // Dev-only contamination guards — RLS enforces company; these catch branch leaks.
      assertCompanyScoped(rows, currentBusiness.id, "useVendorCreditNotes.fetchCreditNotes");
      assertBranchScoped(rows, currentBranch?.id ?? null, "useVendorCreditNotes.fetchCreditNotes");
      setCreditNotes(rows);
    }
    setIsLoading(false);
  }, [currentOrg?.id, currentBusiness?.id, currentBranch?.id]);

  useEffect(() => {
    fetchCreditNotes();
  }, [fetchCreditNotes]);

  const getNextCreditNoteNumber = async (): Promise<string> => {
    if (!currentOrg) throw new Error("No organization selected");
    if (!currentBusiness) throw new Error("No company selected");
    // ADR 0131: numbering is business-scoped and advisory-locked server-side.
    // No client-side fallback — a silent "VCN-001" would collide.
    const { data, error } = await supabase.rpc("get_next_vendor_credit_note_number", {
      p_organization_id: currentOrg.id,
      p_business_id: currentBusiness.id,
    } as any);
    if (error) throw error;
    return data as unknown as string;
  };

  const createVendorCreditNote = async (
    creditNote: Omit<VendorCreditNote, "id" | "organization_id" | "business_id" | "branch_id" | "created_by" | "created_at" | "updated_at" | "vendor" | "bill" | "items">,
    items: Omit<VendorCreditNoteItem, "id" | "credit_note_id">[],
    clientRequestId?: string,
    lineage?: VendorCreditNoteLineage,
  ) => {
    if (!currentOrg || !currentBusiness || !user) throw new Error("No organization selected");

    // ADR 0132: one writer creates the header, its lines and its number in a
    // single transaction. The browser never inserts into vendor_credit_notes
    // and never allocates the number itself. `clientRequestId` makes the
    // creation idempotent — a retry or double submit replays instead of
    // minting a second credit note. Lineage (return / GRN / PO / supplier doc)
    // is stamped by the same writer so provenance can never be added later.
    const { data, error } = await supabase.rpc("create_vendor_credit_note_atomic" as any, {
      _org_id: currentOrg.id,
      _business_id: currentBusiness.id,
      _branch_id: currentBranch?.id ?? null,
      _vendor_id: creditNote.vendor_id,
      _bill_id: (creditNote as any).bill_id ?? null,
      _credit_date: creditNote.credit_date,
      _notes: creditNote.notes ?? null,
      _items: items,
      _issue: false,
      _client_request_id: clientRequestId ?? null,
      _origin: lineage?.origin ?? creditNote.origin ?? "adjustment",
      _reason_code: lineage?.reason_code ?? creditNote.reason_code ?? null,
      _source_return_id: lineage?.source_return_id ?? null,
      _goods_receipt_id: lineage?.goods_receipt_id ?? null,
      _purchase_order_id: lineage?.purchase_order_id ?? null,
      _vendor_document_number:
        lineage?.vendor_document_number ?? creditNote.vendor_document_number ?? null,
      _vendor_document_date:
        lineage?.vendor_document_date ?? creditNote.vendor_document_date ?? null,
      _exchange_rate: lineage?.exchange_rate ?? null,
      _exchange_rate_date: lineage?.exchange_rate_date ?? null,
    });


    if (error) throw error;
    const result = (data ?? {}) as { id: string; credit_note_number: string; replayed?: boolean };

    if (!result.replayed) {
      logAction({
        action: "created",
        entityType: "credit_note",
        entityId: result.id,
        entityName: result.credit_note_number,
        changesSummary: `Created vendor credit note ${result.credit_note_number}`,
      });
    }

    toast({ title: "Vendor credit note created", description: result.credit_note_number });
    await fetchCreditNotes();
    return result as any;
  };


  /**
   * Edit a draft vendor credit note (header + items).
   *
   * Server-authoritative: `update_vendor_credit_note_atomic` locks the row,
   * refuses anything that is not a draft, replaces the lines and recomputes
   * subtotal / tax / total from those lines. The browser never writes
   * `vendor_credit_notes` or `vendor_credit_note_items` and never decides
   * document money.
   */
  const updateVendorCreditNote = async (
    id: string,
    updates: Partial<Omit<VendorCreditNote, "id" | "organization_id" | "business_id" | "branch_id" | "created_by" | "created_at" | "updated_at" | "vendor" | "bill" | "items">>,
    items: Omit<VendorCreditNoteItem, "id" | "credit_note_id">[],
  ) => {
    const existing = creditNotes.find((c) => c.id === id);
    if (!existing) throw new Error("Credit note not found");

    const { error } = await supabase.rpc("update_vendor_credit_note_atomic" as any, {
      _vcn_id: id,
      _vendor_id: updates.vendor_id ?? null,
      _bill_id: (updates as any).bill_id ?? null,
      _credit_date: updates.credit_date ?? null,
      _notes: updates.notes ?? null,
      _items: items.map((item, i) => ({ ...item, sort_order: i })),
      _origin: updates.origin ?? null,
      _reason_code: updates.reason_code ?? null,
      _vendor_document_number: updates.vendor_document_number ?? null,
      _vendor_document_date: updates.vendor_document_date ?? null,
    });

    if (error) throw error;


    logAction({
      action: "updated",
      entityType: "credit_note",
      entityId: id,
      entityName: existing.credit_note_number,
      changesSummary: `Updated vendor credit note ${existing.credit_note_number}`,
    });

    toast({ title: "Vendor credit note updated", description: existing.credit_note_number });
    await fetchCreditNotes();
  };


  /**
   * Issue a draft VCN (ADR 0132 — mirrors `issue_credit_note_atomic`).
   * `issue_vendor_credit_note_atomic`:
   *  - locks the VCN row and resolves GL accounts server-side
   *  - reduces AP only up to the linked bill's still-open balance; the
   *    remainder becomes vendor credit on the dedicated Vendor Credits
   *    account, recorded as an append-only `vendor_credit_movements` row
   *  - posts through `post_journal_entry_atomic` only
   *  - flips status and links journal_entry_id in the same transaction
   */
  /**
   * Governance (ADR 0132 Phase 3). Submitting routes through the canonical
   * approval engine (`approval_route('vendor_credit_note.approve', …)`); when a
   * rule matches, the decision is taken in the approvals inbox and mirrored
   * back onto the note. Approving your own note still needs an override.
   */
  const submitVendorCreditNote = async (id: string) => {
    const { data, error } = await supabase.rpc("vendor_credit_note_submit" as any, { _id: id });
    if (error) throw error;
    const res = (data ?? {}) as { gated?: boolean };
    toast({
      title: res.gated ? "Sent for approval" : "Submitted",
      description: res.gated
        ? "An approver has been notified in the approvals inbox."
        : "This credit note is ready to be approved.",
    });
    await fetchCreditNotes();
    return res;
  };

  const approveVendorCreditNote = async (id: string) => {
    const { error } = await supabase.rpc("vendor_credit_note_approve" as any, { _id: id });
    if (error) throw error;
    toast({ title: "Credit note approved" });
    await fetchCreditNotes();
  };

  const rejectVendorCreditNote = async (id: string, reason?: string) => {
    const { error } = await supabase.rpc("vendor_credit_note_reject" as any, {
      _id: id,
      _reason: reason ?? null,
    });
    if (error) throw error;
    toast({ title: "Credit note rejected" });
    await fetchCreditNotes();
  };

  const cancelVendorCreditNote = async (id: string, reason?: string) => {
    const { error } = await supabase.rpc("vendor_credit_note_cancel" as any, {
      _id: id,
      _reason: reason ?? null,
    });
    if (error) throw error;
    toast({ title: "Credit note cancelled" });
    await fetchCreditNotes();
  };

  const confirmVendorCreditNote = async (id: string) => {
    if (!user) throw new Error("Not authenticated");
    const cn = creditNotes.find((c) => c.id === id);
    if (!cn) throw new Error("Credit note not found");
    if ((cn as any).accounting_status && (cn as any).accounting_status !== "unposted") {
      throw new Error("This credit note has already been posted");
    }


    const { data, error } = await supabase.rpc("issue_vendor_credit_note_atomic" as any, {
      _vcn_id: id,
    });


    if (error) throw new Error(`Credit note confirmation failed: ${error.message}`);
    const result = (data ?? {}) as { success?: boolean };
    if (result.success === false) {
      throw new Error("Credit note confirmation failed (RPC reported failure).");
    }

    logAction({
      action: "confirmed" as any,
      entityType: "credit_note",
      entityId: id,
      entityName: cn.credit_note_number,
      changesSummary: `Confirmed vendor credit note ${cn.credit_note_number} and posted to GL`,
    });

    toast({ title: "Credit note confirmed", description: `${cn.credit_note_number} has been confirmed and posted to GL.` });
    await fetchCreditNotes();
  };

  /**
   * Delete a draft vendor credit note. Server-authoritative:
   * `delete_vendor_credit_note_atomic` refuses anything that is not a draft
   * and anything that already carries a journal entry.
   */
  const deleteVendorCreditNote = async (id: string) => {
    const { error } = await supabase.rpc("delete_vendor_credit_note_atomic" as any, {
      _vcn_id: id,
    });
    if (error) throw error;

    toast({ title: "Credit note deleted" });
    await fetchCreditNotes();
  };


  /**
   * Apply an issued vendor credit FIFO across one or many bills (ADR 0132).
   * `apply_vendor_credit_fifo_atomic` reads availability from
   * `vendor_credit_balances` (never from document columns), allocates FIFO by
   * `bills.due_date` then `created_at`, and delegates each allocation to
   * `apply_vendor_credit_to_bill_atomic`, which writes the application row,
   * the credit movement and the journal entry. The browser chooses nothing.
   * Pass `billIds` to restrict allocation to a specific set; omit for
   * "any open bill for this vendor + currency".
   */
  const applyCreditFifo = async (creditNoteId: string, billIds?: string[]) => {
    if (!currentOrg || !currentBusiness || !user) throw new Error("No organization selected");

    const cn = creditNotes.find((c) => c.id === creditNoteId);
    if (!cn) throw new Error("Credit note not found");
    if (cn.status !== "confirmed") throw new Error("Only confirmed credit notes can be applied");

    const { data, error } = await supabase.rpc("apply_vendor_credit_fifo_atomic" as any, {
      _org_id: currentOrg.id,
      _business_id: currentBusiness.id,
      _vendor_credit_note_id: creditNoteId,
      _bill_ids: billIds ?? null,
      _applied_by: user.id,
      _branch_id: cn.branch_id ?? currentBranch?.id ?? null,
    });


    if (error) throw error;
    const result = data as any;
    if (result && result.success === false) {
      throw new Error(result.error || "Failed to apply credit");
    }

    const totalApplied = result?.total_applied ?? 0;
    const allocations = (result?.allocations ?? []) as Array<{ bill_id: string; amount: number }>;

    logAction({
      action: "updated",
      entityType: "credit_note",
      entityId: creditNoteId,
      entityName: cn.credit_note_number,
      changesSummary: `Applied ${totalApplied} from ${cn.credit_note_number} across ${allocations.length} bill(s) (FIFO)`,
    });

    toast({
      title: "Credit applied",
      description: `${totalApplied} allocated across ${allocations.length} bill(s)`,
    });
    await fetchCreditNotes();
    return result;
  };

  // Back-compat alias for the legacy single-bill call site. Delegates to
  // FIFO with a single-element `billIds` array so callers keep working
  // while `VendorCreditNotes.tsx` migrates to the new multi-bill dialog.
  const applyToBill = async (creditNoteId: string, billId: string, _applyAmount: number) => {
    return applyCreditFifo(creditNoteId, [billId]);
  };

  return {
    creditNotes,
    isLoading,
    getNextCreditNoteNumber,
    createVendorCreditNote,
    updateVendorCreditNote,
    submitVendorCreditNote,
    approveVendorCreditNote,
    rejectVendorCreditNote,
    cancelVendorCreditNote,
    confirmVendorCreditNote,
    deleteVendorCreditNote,
    applyToBill,
    applyCreditFifo,
    refreshCreditNotes: fetchCreditNotes,
  };

}

