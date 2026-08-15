import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { useBranch } from "@/contexts/BranchContext";
import { queryKeys } from "@/lib/queryKeys";
import { toast } from "sonner";
import { triggerAutomation, getChangedFields } from "@/lib/automations/triggerAutomation";
import { applyBranchFilter } from "@/lib/branchScope";
import { normalizeError } from "@/services/resilience";

export interface SalesOrder {
  id: string;
  organization_id: string;
  contact_id: string | null;
  so_number: string;
  order_date: string;
  expected_date: string | null;
  status: string;
  currency: string;
  subtotal: number;
  tax_amount: number;
  discount_amount: number;
  shipping_amount: number;
  total: number;
  shipping_address: string | null;
  /** Structured link to the chosen saved address (ADR-0038 child contact). */
  ship_to_contact_id?: string | null;
  notes: string | null;
  converted_invoice_id: string | null;
  converted_at: string | null;
  source_estimate_id: string | null;
  created_by: string | null;
  salesperson_id: string | null;
  payment_term_id: string | null;
  created_at: string;
  updated_at: string;
  is_locked?: boolean;
  branch_id?: string | null;
  business_id?: string | null;
  /** Phase 6b — the warehouse confirmation reserves stock against. */
  warehouse_id?: string | null;
  contact?: { name: string; email: string | null } | null;
  items?: SalesOrderItem[];
}

export interface SalesOrderItem {
  id: string;
  sales_order_id: string;
  product_id: string | null;
  description: string;
  quantity: number;
  quantity_fulfilled: number;
  unit_price: number;
  tax_rate: number | null;
  tax_amount: number | null;
  discount_percent: number | null;
  line_total: number;
  sort_order: number;
}

/**
 * Canonical per-line quantity ledger (`so_line_balances`).
 *
 * Fulfilment and billing progress is READ ONLY from this view — never re-summed
 * from `sales_order_items`, `delivery_note_items` or `invoice_items` in app
 * code, which is how the two invoicing routes used to disagree.
 */
export interface SalesOrderLineBalance {
  sales_order_id: string;
  sales_order_item_id: string;
  quantity_ordered: number;
  quantity_delivered: number;
  quantity_invoiced: number;
  quantity_returned: number;
  quantity_cancelled: number;
  quantity_open_to_deliver: number;
  quantity_open_to_invoice: number;
  quantity_on_open_deliveries: number;
  quantity_open_to_plan: number;
}

export function useSalesOrderLineBalances(salesOrderId?: string) {
  return useQuery({
    queryKey: ["so_line_balances", salesOrderId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("so_line_balances" as any)
        .select("*")
        .eq("sales_order_id", salesOrderId!);
      if (error) throw error;
      return (data || []) as unknown as SalesOrderLineBalance[];
    },
    enabled: !!salesOrderId,
  });
}


async function fetchSalesOrdersFn(orgId: string, businessId: string, branchId: string | null) {
  let query = supabase
    .from("sales_orders")
    .select(`
      *,
      contact:contacts!sales_orders_contact_id_fkey(name, email)
    `)
    .eq("organization_id", orgId)
    .eq("business_id", businessId)
    .order("created_at", { ascending: false });
  query = applyBranchFilter(query, branchId);
  const { data, error } = await query;

  if (error) throw error;
  return (data || []) as SalesOrder[];
}

export function useSalesOrders() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranch();
  const queryClient = useQueryClient();

  const orgId = currentOrg?.id;
  const businessId = currentBusiness?.id;
  const branchId = currentBranch?.id ?? null;

  const { data: salesOrders = [], isLoading } = useQuery({
    queryKey: [...queryKeys.salesOrders.list(orgId!, businessId), branchId],
    queryFn: () => fetchSalesOrdersFn(orgId!, businessId!, branchId),
    enabled: !!orgId && !!businessId,
  });

  const invalidate = useCallback(() => {
    if (!orgId) return;
    queryClient.invalidateQueries({ queryKey: queryKeys.salesOrders.all(orgId) });
    queryClient.invalidateQueries({ queryKey: ["paginated-list", "sales_orders"] });
  }, [queryClient, orgId]);

  /**
   * Reserve a preview-only order number.
   *
   * Do NOT use this to mint the number you then insert with: the number is
   * only collision-safe when it is taken inside the same transaction as the
   * INSERT, which is what `create_sales_order_atomic` does.
   */
  const getNextNumber = async () => {
    if (!currentOrg || !currentBusiness) return "";
    const { data, error } = await supabase.rpc("get_next_so_number", {
      _org_id: currentOrg.id,
      _business_id: currentBusiness.id,
      _branch_id: branchId,
    } as never);
    if (error) throw error;
    return data as unknown as string;
  };

  /**
   * Create a sales order.
   *
   * Header, lines, numbering, totals and the captured FX rate are written by
   * `create_sales_order_atomic` in ONE transaction. The client no longer
   * pre-mints a number, no longer computes the total that gets stored, and can
   * no longer leave a header behind when the line insert fails.
   */
  const createSalesOrder = async (order: Partial<SalesOrder>, items: Array<{
    description: string;
    unit_price: number;
    line_total: number;
    quantity?: number;
    product_id?: string | null;
    tax_rate?: number | null;
    tax_amount?: number | null;
    discount_percent?: number | null;
  }>) => {
    if (!currentOrg || !currentBusiness) return null;

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      const { data, error } = await supabase.rpc("create_sales_order_atomic" as any, {
        p_header: {
          organization_id: currentOrg.id,
          business_id: currentBusiness.id,
          branch_id: branchId,
          contact_id: order.contact_id ?? null,
          order_date: order.order_date || new Date().toISOString().split("T")[0],
          expected_date: order.expected_date ?? null,
          status: order.status || "draft",
          currency: order.currency || currentBusiness.base_currency,
          discount_amount: order.discount_amount ?? 0,
          shipping_amount: order.shipping_amount ?? 0,
          shipping_address: order.shipping_address ?? null,
          notes: order.notes ?? null,
          salesperson_id: order.salesperson_id ?? user.id,
          payment_term_id: order.payment_term_id ?? null,
          project_id: (order as { project_id?: string | null }).project_id ?? null,
          source_estimate_id: order.source_estimate_id ?? null,
        },
        p_items: items.map((item, index) => ({
          description: item.description,
          unit_price: item.unit_price,
          line_total: item.line_total,
          quantity: item.quantity ?? 1,
          product_id: item.product_id ?? null,
          tax_rate: item.tax_rate ?? 0,
          tax_amount: item.tax_amount ?? 0,
          discount_percent: item.discount_percent ?? 0,
          sort_order: index,
          project_id: (item as { project_id?: string | null }).project_id ?? null,
          task_id: (item as { task_id?: string | null }).task_id ?? null,
        })),
        p_user_id: user.id,
      });
      if (error) throw error;

      const result = data as { success: boolean; sales_order_id: string; so_number: string };
      if (!result?.success) throw new Error("Failed to create sales order");

      // Read back the persisted row so callers and automations see the
      // server-computed totals rather than a client-side guess.
      const { data: newOrder, error: readError } = await supabase
        .from("sales_orders")
        .select("*")
        .eq("id", result.sales_order_id)
        .single();
      if (readError) throw readError;

      toast.success(`Sales order ${result.so_number} created`);

      triggerAutomation({
        event_type: "on_create",
        target_model: "sales_order",
        record_id: newOrder.id,
        record_data: newOrder,
        organization_id: currentOrg.id,
      });

      invalidate();
      return newOrder as SalesOrder;
    } catch (error) {
      console.error("Error creating sales order:", error);
      toast.error(normalizeError(error).message || "Failed to create sales order");
      return null;
    }
  };


  /**
   * Benign header fields a user may edit directly on an existing order.
   *
   * Everything else on `sales_orders` is owned by a database engine:
   * `status` by `confirm_sales_order_atomic` / `cancel_sales_order_atomic` /
   * `set_sales_order_approval_state_atomic`, the money columns and the line
   * structure by `update_sales_order_atomic`, `converted_invoice_id` /
   * `is_locked` by the invoicing routes, `exchange_rate` by
   * `resolve_sales_exchange_rate` at creation, and the quantity ledger by
   * triggers. A generic passthrough update let the UI bypass all of them.
   */
  const EDITABLE_HEADER_FIELDS = new Set([
    "notes",
    "expected_date",
    "shipping_address",
    "customer_reference",
    "delivery_instructions",
    "payment_term_id",
    "salesperson_id",
    "contact_id",
  ]);

  const updateSalesOrder = async (id: string, updates: Partial<SalesOrder>) => {
    try {
      const { contact, items, ...rest } = updates as Record<string, unknown> as any;

      const governed = Object.keys(rest).filter((k) => !EDITABLE_HEADER_FIELDS.has(k));
      if (governed.length > 0) {
        throw new Error(
          `Cannot write ${governed.join(", ")} directly on a sales order — ` +
            `these fields are owned by the sales-order engines (confirm / cancel / ` +
            `approval / update RPCs). Use the corresponding action instead.`,
        );
      }

      const dbUpdates = rest as Record<string, unknown>;
      if (Object.keys(dbUpdates).length === 0) return;

      const { error } = await supabase
        .from("sales_orders")
        .update(dbUpdates as never)
        .eq("id", id);

      if (error) throw error;
      toast.success("Sales order updated successfully");

      const oldOrder = salesOrders.find((so) => so.id === id);
      if (oldOrder && currentOrg) {
        const changedFields = getChangedFields(oldOrder as unknown as Record<string, unknown>, dbUpdates);
        triggerAutomation({
          event_type: changedFields.length > 0 ? "field_change" : "on_update",
          target_model: "sales_order",
          record_id: id,
          record_data: { ...oldOrder, ...dbUpdates },
          old_data: oldOrder as unknown as Record<string, unknown>,
          changed_fields: changedFields,
          organization_id: currentOrg.id,
        });
      }

      invalidate();
    } catch (error) {
      console.error("Error updating sales order:", error);
      toast.error(normalizeError(error).message || "Failed to update sales order");
    }
  };

  /**
   * Deletion is only legal for a never-confirmed draft — nothing downstream can
   * exist yet, so there is no history to preserve. Every other state is
   * compensated with `cancelSalesOrder`, never deleted. The state is re-read
   * from the database rather than trusted from the list cache, and
   * `trg_enforce_sales_order_delete_status` is the final authority.
   */
  const deleteSalesOrder = async (id: string) => {
    try {
      const { data: current, error: readError } = await supabase
        .from("sales_orders")
        .select("status")
        .eq("id", id)
        .single();
      if (readError) throw readError;

      if (current?.status !== "draft") {
        toast.error(
          `Only draft sales orders can be deleted (this one is ${current?.status}). ` +
            `Cancel it instead so the history is preserved.`,
        );
        throw new Error(`Cannot delete SO with status: ${current?.status}`);
      }

      const { error } = await supabase
        .from("sales_orders")
        .delete()
        .eq("id", id);

      if (error) throw error;
      toast.success("Draft sales order deleted");
      invalidate();
    } catch (error) {
      console.error("Error deleting sales order:", error);
      toast.error(normalizeError(error).message || "Failed to delete sales order");
    }
  };


  /**
   * Confirm a draft sales order — flips status to `confirmed` and creates per-line
   * stock reservations atomically (Odoo-grade SO lifecycle).
   * Skipped reservations (out of stock) do not block confirmation.
   */
  const confirmSalesOrder = async (id: string) => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      const { data, error } = await supabase.rpc("confirm_sales_order_atomic", {
        p_so_id: id,
        p_user_id: user.id,
      });
      if (error) throw error;
      const result = data as any;
      if (!result?.success) throw new Error(result?.error || "Failed to confirm sales order");

      const created = result.reservations_created ?? 0;
      const skipped = result.reservations_skipped ?? 0;
      toast.success(
        `Sales order confirmed${
          created > 0 ? ` — ${created} stock reservation(s) created` : ""
        }`
      );

      // A skipped reservation is a real fulfilment gap: the order is confirmed
      // and the customer is promised goods the warehouse has not set aside.
      // Burying that in the tail of a success toast let it go unnoticed, so
      // raise it separately, name the products, and keep it on screen long
      // enough to act on.
      if (skipped > 0) {
        const reasons = Array.isArray(result.skip_reasons) ? result.skip_reasons : [];
        const detail = reasons
          .slice(0, 4)
          .map((r: any) =>
            [r?.product_name ?? r?.product_id, r?.reason].filter(Boolean).join(": "),
          )
          .filter(Boolean)
          .join("\n");
        toast.warning(
          `${skipped} line(s) could not be reserved — insufficient stock`,
          {
            description:
              (detail || "Review stock levels and backorder or restock these lines.") +
              (reasons.length > 4 ? `\n…and ${reasons.length - 4} more` : ""),
            duration: 12000,
          },
        );
      }
      invalidate();
      return true;
    } catch (err: any) {
      console.error("Error confirming SO:", err);
      toast.error(normalizeError(err).message || "Failed to confirm sales order");
      return false;
    }
  };

  /**
   * Cancel a sales order.
   *
   * Cancellation is a compensating business event owned by the database, not a
   * client-side status overwrite. `cancel_sales_order_atomic` validates the
   * cancellable states, refuses orders that are already invoiced or partly
   * delivered, releases stock reservations, breaks crossdock plans, cancels
   * still-pending delivery notes and writes the audit row — all in one
   * transaction. Never write `status = 'cancelled'` from the client.
   */
  const cancelSalesOrder = async (id: string, reason?: string) => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      const { data, error } = await supabase.rpc("cancel_sales_order_atomic" as any, {
        p_so_id: id,
        p_user_id: user.id,
        p_reason: reason ?? null,
      });
      if (error) throw error;
      const result = data as {
        success: boolean;
        already_cancelled?: boolean;
        reservations_released?: number;
        delivery_notes_cancelled?: number;
      };
      if (!result?.success) throw new Error("Failed to cancel sales order");

      if (result.already_cancelled) {
        toast.success("Sales order is already cancelled");
      } else {
        const released = result.reservations_released ?? 0;
        const dns = result.delivery_notes_cancelled ?? 0;
        toast.success(
          `Sales order cancelled${released > 0 ? ` — ${released} reservation(s) released` : ""}${
            dns > 0 ? `, ${dns} pending delivery note(s) cancelled` : ""
          }`
        );
      }
      invalidate();
      return true;
    } catch (err: any) {
      console.error("Error cancelling SO:", err);
      toast.error(normalizeError(err).message || "Failed to cancel sales order");
      return false;
    }
  };


  const convertToInvoice = async (salesOrderId: string) => {
    if (!currentOrg) return null;
    
    try {
      // Sales audit Phase B (finding #16): wrap invoice insert + items copy +
      // SO status flip in one DB transaction via convert_so_to_invoice_atomic.
      // Previously the client did invoice.insert → items.insert → so.update,
      // and a failure on the third step left an orphan invoice with the SO
      // still showing 'confirmed'. The RPC also enforces business access.
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      const { data, error } = await supabase.rpc("convert_so_to_invoice_atomic" as any, {
        p_so_id: salesOrderId,
        p_user_id: user.id,
      });
      if (error) throw error;
      const result = data as { success: boolean; invoice_id: string; invoice_number: string };
      if (!result?.success) throw new Error("SO conversion failed");

      toast.success(`Converted to invoice ${result.invoice_number}`);
      invalidate();
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      return { id: result.invoice_id, invoice_number: result.invoice_number };
    } catch (error) {
      console.error("Error converting sales order to invoice:", error);
      toast.error((error as any)?.message || "Failed to convert sales order");
      return null;
    }
  };

  /**
   * Phase 5: delivery-note creation for a sales order is DB-owned
   * (`create_delivery_from_sales_order_atomic`). Numbering, business/branch
   * inheritance, status guards and open-to-plan quantities (which net off
   * quantity already sitting on other open delivery notes) all happen inside
   * one transaction — the client no longer inserts header-then-lines.
   */
  const createDeliveryNote = async (
    salesOrderId: string,
    customQuantities?: Record<string, number>,
  ) => {
    if (!currentOrg) return null;

    try {
      const { data: { user } } = await supabase.auth.getUser();

      const { data, error } = await supabase.rpc(
        "create_delivery_from_sales_order_atomic" as any,
        {
          p_so_id: salesOrderId,
          p_user_id: user?.id ?? null,
          p_line_qtys: customQuantities ?? null,
        },
      );

      if (error) throw error;

      const result = data as unknown as {
        success?: boolean;
        error?: string;
        delivery_note_id?: string;
        delivery_number?: string;
      };

      if (!result?.success) {
        toast.error(result?.error || "Failed to create delivery note");
        return null;
      }

      toast.success(`Delivery note ${result.delivery_number} created`);
      invalidate();
      queryClient.invalidateQueries({ queryKey: ['delivery-notes'] });
      return { id: result.delivery_note_id!, delivery_number: result.delivery_number! };
    } catch (error) {
      console.error("Error creating delivery note:", error);
      toast.error((error as any)?.message || "Failed to create delivery note");
      return null;
    }
  };

  return {
    salesOrders,
    isLoading,
    refresh: invalidate,
    createSalesOrder,
    updateSalesOrder,
    deleteSalesOrder,
    confirmSalesOrder,
    cancelSalesOrder,
    convertToInvoice,
    createDeliveryNote,
  };
}
