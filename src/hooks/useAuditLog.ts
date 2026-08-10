import { useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { useAuth } from "@/contexts/AuthContext";
import type { Json } from "@/integrations/supabase/types";

export type AuditAction = 
  | "created" 
  | "updated" 
  | "deleted" 
  | "sent" 
  | "viewed" 
  | "paid" 
  | "partial_paid"
  | "converted" 
  | "submitted"
  | "approved" 
  | "rejected" 

  | "cancelled"
  | "voided"
  | "confirmed"
  | "unreconciled"
  | "unapplied"
  | "refunded"
  | "reapplied"
  | "reversed"
  | "credit_note_issued"
  | "deposit_applied"
  | "status_changed";

export type EntityType = 
  | "invoice" 
  | "estimate" 
  | "payment" 
  | "expense" 
  | "contact" 
  | "product" 
  | "bill"
  | "bill_payment"
  | "purchase_order"
  | "goods_receipt"
  | "purchase_return"
  | "sales_order"
  | "credit_note"
  | "delivery_note"
  | "proforma_invoice"
  | "recurring_invoice"
  | "bank_account"
  | "bank_transaction"
  | "customer_group"
  | "payroll_run"
  | "employee"
  | "leave_request"
  | "fixed_asset"
  | "depreciation"
  | "finance_settings"
  | "organization_lock_dates"
  | "vendor_credit_note"
  | "customer_refund";

interface LogActionParams {
  action: AuditAction;
  entityType: EntityType;
  entityId: string;
  entityName?: string;
  oldValues?: Record<string, unknown>;
  newValues?: Record<string, unknown>;
  changesSummary?: string;
}

export function useAuditLog() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { user } = useAuth();

  const logAction = useCallback(async ({
    action,
    entityType,
    entityId,
    entityName,
    oldValues,
    newValues,
    changesSummary,
  }: LogActionParams) => {
    if (!currentOrg) {
      console.warn("Cannot log audit action: no organization selected");
      return;
    }

    try {
      // Generate changes summary if not provided
      let summary = changesSummary;
      if (!summary && oldValues && newValues) {
        const changes: string[] = [];
        for (const key of Object.keys(newValues)) {
          if (JSON.stringify(oldValues[key]) !== JSON.stringify(newValues[key])) {
            changes.push(`${key}: ${oldValues[key]} → ${newValues[key]}`);
          }
        }
        if (changes.length > 0) {
          summary = changes.slice(0, 3).join(", ");
          if (changes.length > 3) {
            summary += ` (+${changes.length - 3} more)`;
          }
        }
      }

      const { error } = await supabase.from("audit_logs").insert([{
        organization_id: currentOrg.id,
        business_id: currentBusiness?.id || null,
        user_id: user?.id || null,
        action,
        entity_type: entityType,
        entity_id: entityId,
        entity_name: entityName || null,
        old_values: (oldValues as Json) || null,
        new_values: (newValues as Json) || null,
        changes_summary: summary || `${action} ${entityType}`,
      }]);

      if (error) {
        console.error("Error logging audit action:", error);
      }
    } catch (err) {
      console.error("Failed to log audit action:", err);
    }
  }, [currentOrg, currentBusiness, user]);

  return { logAction };
}
