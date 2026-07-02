/**
 * Approval Gate Hook
 * 
 * Checks approval_rules before entity state transitions.
 * If a matching rule triggers, blocks the action and creates
 * a pending approval_rule_logs entry.
 */
import { useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useAuth } from "@/contexts/AuthContext";

export interface ApprovalCheckResult {
  blocked: boolean;
  ruleId?: string;
  ruleName?: string;
  message?: string;
  existingLogId?: string;
  status?: string;
}

interface ThresholdCheck {
  threshold_field: string | null;
  threshold_operator: string | null;
  threshold_value: number | null;
}

function evaluateThreshold(
  rule: ThresholdCheck,
  currentValues: Record<string, unknown>
): boolean {
  if (!rule.threshold_field || !rule.threshold_operator || rule.threshold_value == null) {
    // No threshold condition → rule always triggers
    return true;
  }

  const fieldValue = Number(currentValues[rule.threshold_field] ?? 0);
  const threshold = rule.threshold_value;

  switch (rule.threshold_operator) {
    case ">": return fieldValue > threshold;
    case ">=": return fieldValue >= threshold;
    case "<": return fieldValue < threshold;
    case "<=": return fieldValue <= threshold;
    case "=":
    case "==": return fieldValue === threshold;
    case "!=": return fieldValue !== threshold;
    default: return false;
  }
}

export function useApprovalGate() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { user } = useAuth();

  /**
   * Check if an action on an entity requires approval.
   * Returns { blocked: true } if a matching rule triggers and no approval exists.
   */
  const checkApproval = useCallback(async (
    entityType: string,
    actionName: string,
    entityId: string,
    currentValues: Record<string, unknown> = {}
  ): Promise<ApprovalCheckResult> => {
    if (!currentOrg) return { blocked: false };

    try {
      // 1. Check for existing approved log for this entity+action
      const { data: existingLogs } = await supabase
        .from("approval_rule_logs")
        .select("id, status, rule_id")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .eq("entity_type", entityType)
        .eq("entity_id", entityId)
        .eq("action_name", actionName)
        .order("created_at", { ascending: false })
        .limit(1);

      if (existingLogs && existingLogs.length > 0) {
        const latest = existingLogs[0];
        if (latest.status === "approved") {
          return { blocked: false };
        }
        if (latest.status === "pending") {
          return {
            blocked: true,
            ruleId: latest.rule_id,
            existingLogId: latest.id,
            status: "pending",
            message: "This action is awaiting approval.",
          };
        }
        // If rejected, allow re-request (fall through to check rules again)
      }

      // 2. Fetch active rules for this entity+action
      const { data: rules, error } = await supabase
        .from("approval_rules")
        .select("*")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .eq("entity_type", entityType)
        .eq("action_name", actionName)
        .eq("is_active", true);

      if (error) {
        console.error("Error fetching approval rules:", error);
        return { blocked: false };
      }

      if (!rules || rules.length === 0) {
        return { blocked: false };
      }

      // 3. Evaluate each rule's threshold
      for (const rule of rules) {
        const triggers = evaluateThreshold(
          {
            threshold_field: rule.threshold_field,
            threshold_operator: rule.threshold_operator,
            threshold_value: rule.threshold_value,
          },
          currentValues
        );

        if (triggers) {
          return {
            blocked: true,
            ruleId: rule.id,
            ruleName: rule.description || `${entityType} ${actionName} approval`,
            message: rule.threshold_field
              ? `Approval required: ${rule.threshold_field} ${rule.threshold_operator} ${rule.threshold_value}`
              : `Approval required for this action.`,
          };
        }
      }

      return { blocked: false };
    } catch (err) {
      console.error("Approval gate error:", err);
      return { blocked: false };
    }
  }, [currentOrg]);

  /**
   * Create a pending approval request
   */
  const requestApproval = useCallback(async (
    entityType: string,
    actionName: string,
    entityId: string,
    ruleId: string,
    notes?: string
  ): Promise<string | null> => {
    if (!currentOrg || !user) return null;

    const { data, error } = await supabase
      .from("approval_rule_logs")
      .insert({
        organization_id: currentOrg.id,
        business_id: currentBusiness.id,
        rule_id: ruleId,
        entity_type: entityType,
        entity_id: entityId,
        action_name: actionName,
        status: "pending",
        requested_by: user.id,
        notes: notes || null,
      } as any)
      .select("id")
      .single();

    if (error) {
      console.error("Error creating approval request:", error);
      return null;
    }
    return data?.id || null;
  }, [currentOrg, user]);

  /**
   * Approve a pending request (for approvers)
   */
  const approveRequest = useCallback(async (logId: string, notes?: string) => {
    if (!user) return false;
    const { error } = await supabase
      .from("approval_rule_logs")
      .update({
        status: "approved",
        approved_by: user.id,
        approved_at: new Date().toISOString(),
        notes: notes || null,
      } as any)
      .eq("id", logId);

    return !error;
  }, [user]);

  /**
   * Reject a pending request (for approvers)
   */
  const rejectRequest = useCallback(async (logId: string, notes?: string) => {
    if (!user) return false;
    const { error } = await supabase
      .from("approval_rule_logs")
      .update({
        status: "rejected",
        rejected_by: user.id,
        rejected_at: new Date().toISOString(),
        notes: notes || null,
      } as any)
      .eq("id", logId);

    return !error;
  }, [user]);

  return {
    checkApproval,
    requestApproval,
    approveRequest,
    rejectRequest,
  };
}
