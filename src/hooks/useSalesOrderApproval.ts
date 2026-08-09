import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { toast } from "sonner";

export interface ApprovalWorkflow {
  id: string;
  name: string;
  description: string | null;
  entity_type: string;
  conditions: {
    min_amount?: number;
    max_discount_percent?: number;
    new_customer?: boolean;
    credit_hold_customer?: boolean;
  } | null;
  is_active: boolean;
}

export interface PendingApproval {
  id: string;
  sales_order_id: string;
  so_number: string;
  contact_name: string | null;
  total: number;
  requested_by: string | null;
  requested_at: string;
  status: string;
  notes: string | null;
}

export function useSalesOrderApproval() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const [pendingApprovals, setPendingApprovals] = useState<PendingApproval[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (currentOrg) {
      fetchPendingApprovals();
    }
  }, [currentOrg?.id]);

  const fetchPendingApprovals = async () => {
    if (!currentOrg) return;
    // approval_requests is workspace-scoped (no business_id) — that's by design
    setIsLoading(true);

    try {
      const { data, error } = await supabase
        .from("approval_requests")
        .select(`
          id,
          entity_id,
          status,
          notes,
          requested_by,
          requested_at
        `)
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .eq("entity_type", "sales_order")
        .eq("status", "pending")
        .order("requested_at", { ascending: true });

      if (error) throw error;

      // Fetch sales order details for each approval
      const approvals: PendingApproval[] = [];
      for (const approval of data || []) {
        // SCOPE-EXEMPT: lookup by PK (entity_id) — no cross-company leak risk
        const { data: salesOrder } = await supabase
          .from("sales_orders")
          .select("so_number, total, contact:contacts(name)")
          .eq("id", approval.entity_id)
          .single();

        if (salesOrder) {
          approvals.push({
            id: approval.id,
            sales_order_id: approval.entity_id,
            so_number: salesOrder.so_number,
            contact_name: salesOrder.contact?.name || null,
            total: salesOrder.total,
            requested_by: approval.requested_by,
            requested_at: approval.requested_at,
            status: approval.status,
            notes: approval.notes,
          });
        }
      }

      setPendingApprovals(approvals);
    } catch (error) {
      console.error("Error fetching pending approvals:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const checkApprovalRequired = async (salesOrder: {
    total: number;
    discount_amount?: number;
    subtotal?: number;
    contact_id?: string | null;
  }): Promise<{ required: boolean; reason?: string }> => {
    if (!currentOrg) return { required: false };

    try {
      // Fetch active approval workflows for sales orders
      // SCOPE-EXEMPT: workflows are workspace-policy; per-company filtering is by `conditions` JSON
      const { data: workflows, error } = await supabase
        .from("approval_workflows")
        .select("*")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .eq("entity_type", "sales_order")
        .eq("is_active", true);

      if (error) throw error;
      if (!workflows || workflows.length === 0) return { required: false };

      for (const workflow of workflows) {
        const conditions = workflow.conditions as ApprovalWorkflow["conditions"];
        if (!conditions) continue;

        // Check amount threshold
        if (conditions.min_amount && salesOrder.total >= conditions.min_amount) {
          return {
            required: true,
            reason: `Order total (${salesOrder.total}) exceeds approval threshold (${conditions.min_amount})`,
          };
        }

        // Check discount threshold
        if (conditions.max_discount_percent && salesOrder.subtotal && salesOrder.discount_amount) {
          const discountPercent = (salesOrder.discount_amount / salesOrder.subtotal) * 100;
          if (discountPercent > conditions.max_discount_percent) {
            return {
              required: true,
              reason: `Discount (${discountPercent.toFixed(1)}%) exceeds maximum (${conditions.max_discount_percent}%)`,
            };
          }
        }

        // Check if customer is on credit hold
        if (conditions.credit_hold_customer && salesOrder.contact_id) {
          // SCOPE-EXEMPT: lookup by PK (contact_id)
          const { data: contact } = await supabase
            .from("contacts")
            .select("credit_hold")
            .eq("id", salesOrder.contact_id)
            .single();

          if (contact?.credit_hold) {
            return {
              required: true,
              reason: "Customer is on credit hold",
            };
          }
        }

        // Check if new customer (first order)
        if (conditions.new_customer && salesOrder.contact_id && currentBusiness?.id) {
          const { count } = await supabase
            .from("sales_orders")
            .select("*", { count: "exact", head: true })
            .eq("contact_id", salesOrder.contact_id)
            .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
            .eq("business_id", currentBusiness.id);

          if (count === 0) {
            return {
              required: true,
              reason: "First order from new customer",
            };
          }
        }
      }

      return { required: false };
    } catch (error) {
      console.error("Error checking approval requirement:", error);
      return { required: false };
    }
  };

  const submitForApproval = async (salesOrderId: string, notes?: string) => {
    if (!currentOrg) return false;

    try {
      const { data: { user } } = await supabase.auth.getUser();

      // Get the first active workflow for sales orders
      // SCOPE-EXEMPT: workflow policy lookup is workspace-scoped
      const { data: workflow } = await supabase
        .from("approval_workflows")
        .select("id")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .eq("entity_type", "sales_order")
        .eq("is_active", true)
        .limit(1)
        .single();

      // Get sales order number for reference
      const { data: salesOrder } = await supabase
        .from("sales_orders")
        .select("so_number")
        .eq("id", salesOrderId)
        .single();

      const { error } = await supabase
        .from("approval_requests")
        .insert({
          organization_id: currentOrg.id,
        business_id: currentBusiness.id,
          entity_type: "sales_order",
          entity_id: salesOrderId,
          entity_reference: salesOrder?.so_number,
          workflow_id: workflow?.id,
          status: "pending",
          requested_by: user?.id,
          requested_at: new Date().toISOString(),
          notes,
        });

      if (error) throw error;

      // Update sales order status
      await supabase
        .from("sales_orders")
        .update({
          status: "pending_approval",
        })
        .eq("id", salesOrderId);

      toast.success("Order submitted for approval");
      await fetchPendingApprovals();
      return true;
    } catch (error) {
      console.error("Error submitting for approval:", error);
      toast.error("Failed to submit for approval");
      return false;
    }
  };

  const approveOrder = async (approvalId: string, comments?: string) => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      const approval = pendingApprovals.find((a) => a.id === approvalId);
      if (!approval) throw new Error("Approval not found");

      // Update approval request
      const { error } = await supabase
        .from("approval_requests")
        .update({
          status: "approved",
          completed_at: new Date().toISOString(),
        })
        .eq("id", approvalId);

      if (error) throw error;

      // Add approval history
      await supabase.from("approval_history").insert({
        request_id: approvalId,
        step_number: 1,
        action: "approved",
        approved_by: user?.id,
        approved_at: new Date().toISOString(),
        comments,
      });

      // Approval is a governance decision, not a fulfilment decision: move the
      // order to `approved`, then run the confirmation RPC so stock
      // reservations are actually created. Writing `confirmed` directly here
      // used to skip reservations entirely, so approved orders committed no
      // stock and could be oversold.
      await supabase
        .from("sales_orders")
        .update({ status: "approved" })
        .eq("id", approval.sales_order_id);

      const { data: confirmResult, error: confirmError } = await supabase.rpc(
        "confirm_sales_order_atomic",
        { p_so_id: approval.sales_order_id, p_user_id: user?.id as string },
      );
      if (confirmError) throw confirmError;
      const confirmed = confirmResult as { success?: boolean; error?: string } | null;
      if (!confirmed?.success) {
        throw new Error(confirmed?.error || "Approved, but confirmation failed");
      }


      toast.success("Order approved");
      await fetchPendingApprovals();
    } catch (error) {
      console.error("Error approving order:", error);
      toast.error("Failed to approve order");
    }
  };

  const rejectOrder = async (approvalId: string, reason: string) => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      const approval = pendingApprovals.find((a) => a.id === approvalId);
      if (!approval) throw new Error("Approval not found");

      // Update approval request
      const { error } = await supabase
        .from("approval_requests")
        .update({
          status: "rejected",
          completed_at: new Date().toISOString(),
        })
        .eq("id", approvalId);

      if (error) throw error;

      // Add approval history
      await supabase.from("approval_history").insert({
        request_id: approvalId,
        step_number: 1,
        action: "rejected",
        approved_by: user?.id,
        approved_at: new Date().toISOString(),
        comments: reason,
      });

      // Update sales order status
      await supabase
        .from("sales_orders")
        .update({
          status: "rejected",
        })
        .eq("id", approval.sales_order_id);

      toast.success("Order rejected");
      await fetchPendingApprovals();
    } catch (error) {
      console.error("Error rejecting order:", error);
      toast.error("Failed to reject order");
    }
  };

  return {
    pendingApprovals,
    isLoading,
    refresh: fetchPendingApprovals,
    checkApprovalRequired,
    submitForApproval,
    approveOrder,
    rejectOrder,
  };
}
