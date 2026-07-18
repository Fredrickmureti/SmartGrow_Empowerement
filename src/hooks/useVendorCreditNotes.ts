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
  // Multi-Unit provenance (added by migration). Forwarded through `...item`
  // spread in createVendorCreditNote so the BEFORE-trigger `_uom_normalize_line`
  // can stamp qty_in_base_uom / uom_snapshot server-side.
  packaging_id?: string | null;
  display_uom_id?: string | null;
  display_quantity?: number | null;
  uom_snapshot?: string | null;
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
    if (!currentOrg) return "VCN-001";
    try {
      const { data, error } = await supabase.rpc("get_next_vendor_credit_note_number", {
        p_organization_id: currentOrg.id,
      });
      if (error) throw error;
      return data || "VCN-001";
    } catch (err) {
      console.error("Error getting next VCN number via RPC, falling back:", err);
      return "VCN-001";
    }
  };

  const createVendorCreditNote = async (
    creditNote: Omit<VendorCreditNote, "id" | "organization_id" | "business_id" | "branch_id" | "created_by" | "created_at" | "updated_at" | "vendor" | "bill" | "items">,
    items: Omit<VendorCreditNoteItem, "id" | "credit_note_id">[]
  ) => {
    if (!currentOrg || !currentBusiness || !user) throw new Error("No organization selected");

    const { data, error } = await supabase
      .from("vendor_credit_notes")
      .insert({
        ...creditNote,
        organization_id: currentOrg.id,
        business_id: currentBusiness.id,
        branch_id: currentBranch?.id ?? null,
        created_by: user.id,
      } as any)
      .select()
      .single();

    if (error) throw error;

    if (items.length > 0) {
      const itemsToInsert = items.map((item, i) => ({
        ...item,
        credit_note_id: data.id,
        sort_order: i,
      }));
      const { error: itemsError } = await supabase
        .from("vendor_credit_note_items")
        .insert(itemsToInsert);
      if (itemsError) throw itemsError;
    }

    logAction({
      action: "created",
      entityType: "credit_note",
      entityId: data.id,
      entityName: creditNote.credit_note_number,
      changesSummary: `Created vendor credit note ${creditNote.credit_note_number}`,
    });

    toast({ title: "Vendor credit note created", description: creditNote.credit_note_number });
    await fetchCreditNotes();
    return data;
  };

  /**
   * Edit a draft vendor credit note (header + items). Only draft VCNs
   * are editable — confirmed/applied notes must be voided instead.
   * Items are replaced wholesale (delete + re-insert) to keep the
   * client-side model simple; the DB trigger `_uom_normalize_line`
   * still stamps qty_in_base_uom on the inserts.
   */
  const updateVendorCreditNote = async (
    id: string,
    updates: Partial<Omit<VendorCreditNote, "id" | "organization_id" | "business_id" | "branch_id" | "created_by" | "created_at" | "updated_at" | "vendor" | "bill" | "items">>,
    items: Omit<VendorCreditNoteItem, "id" | "credit_note_id">[],
  ) => {
    const existing = creditNotes.find((c) => c.id === id);
    if (!existing) throw new Error("Credit note not found");
    if (existing.status !== "draft") {
      throw new Error("Only draft credit notes can be edited");
    }

    const { vendor: _v, bill: _b, items: _i, ...dbUpdates } = updates as any;

    const { error } = await supabase
      .from("vendor_credit_notes")
      .update(dbUpdates)
      .eq("id", id);
    if (error) throw error;

    // Replace items wholesale
    const { error: delError } = await supabase
      .from("vendor_credit_note_items")
      .delete()
      .eq("credit_note_id", id);
    if (delError) throw delError;

    if (items.length > 0) {
      const itemsToInsert = items.map((item, i) => ({
        ...item,
        credit_note_id: id,
        sort_order: i,
      }));
      const { error: insError } = await supabase
        .from("vendor_credit_note_items")
        .insert(itemsToInsert);
      if (insError) throw insError;
    }

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
   * Confirm a draft VCN atomically.
   * Single RPC call:
   *  - locks the VCN row
   *  - resolves AP + expense default accounts (raises a typed exception if missing)
   *  - posts a balanced JE (Dr AP, Cr Expense)
   *  - flips status='confirmed' + links journal_entry_id
   * Eliminates the previous client-side gap where GL was posted before
   * status update — that gap could double-credit AP on retry.
   */
  const confirmVendorCreditNote = async (id: string) => {
    if (!user) throw new Error("Not authenticated");
    const cn = creditNotes.find((c) => c.id === id);
    if (!cn) throw new Error("Credit note not found");
    if (cn.status !== "draft") throw new Error("Only draft credit notes can be confirmed");

    const { data, error } = await supabase.rpc("confirm_vendor_credit_note_atomic" as any, {
      _vcn_id: id,
      _user_id: user.id,
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

  const deleteVendorCreditNote = async (id: string) => {
    const cn = creditNotes.find((c) => c.id === id);
    if (!cn) throw new Error("Credit note not found");
    if (cn.status !== "draft") throw new Error("Only draft credit notes can be deleted");

    const { error } = await supabase.from("vendor_credit_notes").delete().eq("id", id);
    if (error) throw error;

    toast({ title: "Credit note deleted" });
    await fetchCreditNotes();
  };

  /**
   * Apply a confirmed vendor credit note FIFO across one or many bills.
   * Calls apply_vendor_credit_note_atomic RPC (Batch I-Deferred):
   *  - locks VCN + eligible bills (FOR UPDATE)
   *  - allocates FIFO by bills.due_date (NULLS LAST), then created_at
   *  - inserts one vendor_credit_note_applications row per allocation
   *  - updates bill amount_paid + status per allocation
   *  - updates VCN amount_applied + status
   *  - emits procurement.credit.applied outbox event
   * GL was already posted at VCN confirmation — no double-posting here.
   * Pass `billIds` to restrict allocation to a specific set; omit for
   * "any open bill for this vendor + currency".
   */
  const applyCreditFifo = async (creditNoteId: string, billIds?: string[]) => {
    if (!currentOrg || !user) throw new Error("No organization selected");

    const cn = creditNotes.find((c) => c.id === creditNoteId);
    if (!cn) throw new Error("Credit note not found");
    if (cn.status !== "confirmed") throw new Error("Only confirmed credit notes can be applied");

    const { data, error } = await supabase.rpc("apply_vendor_credit_note_atomic" as any, {
      p_credit_note_id: creditNoteId,
      p_bill_ids: billIds ?? null,
      p_user_id: user.id,
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
    confirmVendorCreditNote,
    deleteVendorCreditNote,
    applyToBill,
    applyCreditFifo,
    refreshCreditNotes: fetchCreditNotes,
  };
}

