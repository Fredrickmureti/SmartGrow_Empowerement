import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { useBranch } from "@/contexts/BranchContext";
import { queryKeys } from "@/lib/queryKeys";
import { toast } from "sonner";
import { applyBranchFilter } from "@/lib/branchScope";
import { looksLikeUUID } from "@/lib/looksLikeUUID";
import { normalizeError } from "@/services/resilience";

export interface DeliveryNote {
  id: string;
  organization_id: string;
  contact_id: string | null;
  delivery_number: string;
  delivery_date: string;
  status: string;
  sales_order_id: string | null;
  shipping_address: string | null;
  /** Structured link to the chosen saved address (ADR-0038 child contact). */
  ship_to_contact_id?: string | null;
  driver_name: string | null;
  vehicle_number: string | null;
  notes: string | null;
  delivered_at: string | null;
  received_by: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  business_id?: string | null;
  contact?: { name: string; email: string | null } | null;
  sales_order?: { so_number: string } | null;
  items?: DeliveryNoteItem[];
}

export interface DeliveryNoteItem {
  id: string;
  delivery_note_id: string;
  product_id: string | null;
  sales_order_item_id: string | null;
  description: string;
  quantity_ordered: number;
  quantity_delivered: number;
  sort_order: number;
}

async function fetchDeliveryNotesFn(orgId: string, businessId: string, branchId: string | null) {
  return fetchDeliveryNotes(orgId, businessId, branchId);
}

/**
 * Header columns the UI may write directly. Everything else — status,
 * delivered_at, dispatched_at, ready_at, spawned_invoice_id, cancellation
 * columns, numbering, lineage — belongs to the delivery RPCs.
 */
const EDITABLE_DN_FIELDS = new Set([
  "notes",
  "delivery_date",
  "shipping_address",
  "driver_name",
  "vehicle_number",
  "contact_id",
  "received_by_contact_id",
  "auto_invoice_on_complete",
]);

async function fetchDeliveryNotes(orgId: string, businessId: string, branchId: string | null) {
  let query = supabase
    .from("delivery_notes")
    .select(`
      *,
      contact:contacts!contact_id(name, email),
      sales_order:sales_orders(so_number)
    `)
    .eq("organization_id", orgId)
    .eq("business_id", businessId)
    .order("created_at", { ascending: false });
  query = applyBranchFilter(query, branchId);
  const { data, error } = await query;

  if (error) throw error;
  return (data || []) as DeliveryNote[];
}

export function useDeliveryNotes() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranch();
  const queryClient = useQueryClient();

  const orgId = currentOrg?.id;
  const businessId = currentBusiness?.id;
  const branchId = currentBranch?.id ?? null;

  const { data: deliveryNotes = [], isLoading } = useQuery({
    queryKey: [...queryKeys.deliveryNotes.list(orgId!, businessId), branchId],
    queryFn: () => fetchDeliveryNotesFn(orgId!, businessId!, branchId),
    enabled: !!orgId && !!businessId,
  });

  const invalidate = useCallback(() => {
    if (!orgId) return;
    queryClient.invalidateQueries({ queryKey: queryKeys.deliveryNotes.all(orgId) });
    queryClient.invalidateQueries({ queryKey: ["delivery-notes-paginated"] });
    queryClient.invalidateQueries({ queryKey: ["stock-movements"] });
    queryClient.invalidateQueries({ queryKey: ["products"] });
  }, [queryClient, orgId]);

  // Numbering is allocated server-side inside create_delivery_note_atomic
  // (advisory-locked, business-scoped). No client-side number reservation.

  const createDeliveryNote = async (
    note: Partial<DeliveryNote> & { auto_invoice_on_complete?: boolean },
    items: Array<{
      description: string;
      quantity_ordered?: number;
      quantity_delivered?: number;
      product_id?: string | null;
      sales_order_item_id?: string | null;
      unit_price?: number | null;
      tax_rate?: number | null;
      tax_amount?: number | null;
      discount_percent?: number | null;
      line_total?: number | null;
    }>,
  ) => {
    if (!currentOrg || !currentBusiness) return null;

    try {
      const { data: { user } } = await supabase.auth.getUser();

      // Single transaction: the number is allocated under an advisory lock and
      // the header + lines are written together. The previous three-step
      // browser sequence (number → header → lines) could strand a header with
      // no lines and could hand the same number to two concurrent users.
      const { data, error } = await (supabase.rpc as any)("create_delivery_note_atomic", {
        p_payload: {
          organization_id: currentOrg.id,
          business_id: currentBusiness.id,
          branch_id: currentBranch?.id ?? null,
          // Phase 6b: goods issue consumes the warehouse recorded here.
          warehouse_id: (note as { warehouse_id?: string | null }).warehouse_id ?? null,
          contact_id: note.contact_id ?? null,
          delivery_date: note.delivery_date || new Date().toISOString().split("T")[0],
          sales_order_id: note.sales_order_id ?? null,
          shipping_address: note.shipping_address ?? null,
          driver_name: note.driver_name ?? null,
          vehicle_number: note.vehicle_number ?? null,
          notes: note.notes ?? null,
          auto_invoice_on_complete: note.auto_invoice_on_complete ?? true,
        },
        p_lines: items.map((item) => ({
          description: item.description,
          quantity_ordered: item.quantity_ordered ?? 0,
          quantity_delivered: item.quantity_delivered ?? 0,
          product_id: item.product_id ?? null,
          sales_order_item_id: item.sales_order_item_id ?? null,
          unit_price: item.unit_price ?? null,
          tax_rate: item.tax_rate ?? null,
          tax_amount: item.tax_amount ?? null,
          discount_percent: item.discount_percent ?? 0,
          line_total: item.line_total ?? null,
          // Phase A.4 — persist picker output for lot/serial-tracked lines.
          lot_number: (item as any).lot_number ?? null,
          serial_number: (item as any).serial_number ?? null,
          lot_allocations: (item as any).lot_allocations ?? null,
          packaging_id: (item as any).packaging_id ?? null,
          display_uom_id: (item as any).display_uom_id ?? null,
          display_quantity: (item as any).display_quantity ?? null,
        })),
        p_user_id: user?.id ?? null,
      });

      if (error) throw error;
      const result = data as { success?: boolean; id?: string; delivery_number?: string } | null;
      if (!result?.success || !result.id) {
        throw new Error((result as any)?.error || "Failed to create delivery note");
      }

      toast.success(`Delivery note ${result.delivery_number ?? ""} created`.trim());
      invalidate();
      return { id: result.id, delivery_number: result.delivery_number } as any;
    } catch (error) {
      console.error("Error creating delivery note:", error);
      toast.error(normalizeError(error).message || "Failed to create delivery note");
      return null;
    }
  };

  const updateDeliveryNote = async (id: string, updates: Partial<DeliveryNote>) => {
    try {
      const { contact, items, sales_order, ...rest } = updates as any;

      // Lifecycle columns are owned by the delivery engines
      // (`mark_delivery_ready_atomic`, `dispatch_delivery_atomic`,
      // `complete_delivery_atomic`, `record_partial_delivery_atomic`,
      // `cancel_delivery_atomic`, `create_invoice_from_delivery_atomic`).
      // A generic passthrough update let the UI flip `status` to
      // `delivered` without moving stock, snapshotting cost or posting
      // COGS — while still firing the completed/shipped event triggers.
      const governed = Object.keys(rest).filter((k) => !EDITABLE_DN_FIELDS.has(k));
      if (governed.length > 0) {
        throw new Error(
          `Cannot write ${governed.join(", ")} directly on a delivery note — ` +
            `these fields are owned by the delivery engines. Use the ` +
            `corresponding action (ready / dispatch / complete / cancel) instead.`,
        );
      }

      const dbUpdates = rest as Record<string, unknown>;
      if (Object.keys(dbUpdates).length === 0) return;

      const { error } = await supabase
        .from("delivery_notes")
        .update(dbUpdates as never)
        .eq("id", id);

      if (error) throw error;
      toast.success("Delivery note updated successfully");
      invalidate();
    } catch (error) {
      console.error("Error updating delivery note:", error);
      toast.error(normalizeError(error).message || "Failed to update delivery note");
    }
  };

  /**
   * A delivery note is a business document, not a CRUD row: once it exists it
   * may already carry lineage (source invoice, sales order, spawned invoice)
   * and, after completion, stock movements and a COGS journal. Removal always
   * routes through `cancel_delivery_atomic`, which writes compensating
   * movements / voids the journal when required, instead of destroying the
   * record.
   */
  const deleteDeliveryNote = async (id: string) => {
    await cancelDelivery(id, "Removed from delivery notes list");
  };

  /**
   * Mark a delivery note as delivered.
   *
   * Stage C2 — delegates to the atomic RPC `complete_delivery_atomic` which:
   *   1. Resolves a warehouse for the DN's branch
   *   2. Validates SO ↔ DN branch coherence (Stage D3)
   *   3. Creates negative stock movements for inventory-tracked items
   *   4. Posts COGS GL (DR COGS / CR Inventory)
   *   5. Updates the delivery note status
   * All in a single transaction — no partial-success states possible.
   */
  const markAsDelivered = async (id: string, receivedBy: string) => {
    if (!currentOrg) return;

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      const cleanRecipient = receivedBy && !looksLikeUUID(receivedBy.trim())
        ? receivedBy
        : null;

      const { data, error } = await supabase.rpc("complete_delivery_atomic", {
        p_dn_id: id,
        p_user_id: user.id,
        p_received_by: cleanRecipient,
        p_received_by_user_id: user.id,
      });

      if (error) throw error;
      const result = data as any;
      if (!result?.success) {
        // Idempotent UX: if the DN is already finalised, refetch the
        // current row + any spawned invoice and rebuild a meaningful
        // toast rather than surface "Delivery already finalised" as a
        // hard error on a duplicate click / network retry.
        const errMsg: string = result?.error || "Failed to mark delivery";
        if (/already finalis/i.test(errMsg)) {
          const { data: existing } = await supabase
            .from("delivery_notes")
            .select("status, spawned_invoice_id")
            .eq("id", id)
            .maybeSingle();
          let invLine: string | null = null;
          if (existing?.spawned_invoice_id) {
            const { data: inv } = await supabase
              .from("invoices")
              .select("invoice_number, status")
              .eq("id", existing.spawned_invoice_id)
              .maybeSingle();
            if (inv?.invoice_number) invLine = `Invoice ${inv.invoice_number} (${inv.status || "draft"})`;
          }
          const parts: string[] = [];
          if (existing?.status) parts.push(`status: ${existing.status}`);
          if (invLine) parts.push(invLine);
          toast.message(
            "Delivery was already completed",
            { description: parts.join(" · ") || undefined }
          );
          invalidate();
          return;
        }
        throw new Error(errMsg);
      }

      const invParts: string[] = [];
      if (result.movements_created) invParts.push(`${result.movements_created} movement(s)`);
      if (result.gl_posted) invParts.push("COGS posted");
      if (result.spawned_invoice_number) invParts.push(`Invoice ${result.spawned_invoice_number} created (draft)`);
      toast.success(
        `Delivery marked as complete${invParts.length ? " — " + invParts.join(", ") : ""}`
      );
      invalidate();
    } catch (error: any) {
      console.error("Error marking delivery:", error);
      toast.error(normalizeError(error).message || "Failed to update delivery status");
    }
  };

  /**
   * Cancel a delivery atomically. If the DN has already moved stock /
   * posted COGS, the RPC writes compensating stock movements and voids
   * the COGS journal entry in the same transaction. If the DN spawned
   * a draft invoice, that invoice is set to `cancelled`. Posted /
   * paid spawned invoices block the cancel and surface a clear error.
   */
  const cancelDelivery = async (id: string, reason: string | null) => {
    if (!currentOrg) return null;
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");
      const { data, error } = await supabase.rpc("cancel_delivery_atomic", {
        p_dn_id: id,
        p_user_id: user.id,
        p_reason: reason,
      });
      if (error) throw error;
      const result = data as any;
      if (!result?.success) throw new Error(result?.error || "Failed to cancel delivery");
      const parts: string[] = [];
      if (result.compensating_movements) parts.push(`${result.compensating_movements} stock movement(s) reversed`);
      if (Array.isArray(result.voided_journal_entries) && result.voided_journal_entries.length) {
        parts.push(`${result.voided_journal_entries.length} COGS entry voided`);
      }
      if (result.spawned_invoice_status_after === "cancelled") parts.push("draft invoice cancelled");
      toast.success(`Delivery cancelled${parts.length ? " — " + parts.join(", ") : ""}`);
      invalidate();
      return result;
    } catch (error: any) {
      console.error("Error cancelling delivery:", error);
      toast.error(normalizeError(error).message || "Failed to cancel delivery");
      return null;
    }
  };

  return {
    deliveryNotes,
    isLoading,
    refresh: invalidate,
    createDeliveryNote,
    updateDeliveryNote,
    deleteDeliveryNote,
    markAsDelivered,
    cancelDelivery,
  };
}
