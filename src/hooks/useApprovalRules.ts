/**
 * Hook for managing approval rules in Studio.
 */
import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { toast } from "sonner";

export interface ApprovalRule {
  id: string;
  organization_id: string;
  entity_type: string;
  action_name: string;
  description: string | null;
  is_active: boolean;
  condition: Record<string, unknown>;
  approver_type: string;
  approver_user_id: string | null;
  approver_role: string | null;
  approval_mode: string;
  threshold_field: string | null;
  threshold_operator: string | null;
  threshold_value: number | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

export interface ApprovalRuleLog {
  id: string;
  rule_id: string;
  organization_id: string;
  entity_type: string;
  entity_id: string;
  action_name: string;
  status: string;
  requested_by: string | null;
  approved_by: string | null;
  approved_at: string | null;
  rejected_by: string | null;
  rejected_at: string | null;
  notes: string | null;
  created_at: string;
}

export function useApprovalRules(entityType?: string) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const [rules, setRules] = useState<ApprovalRule[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchRules = useCallback(async () => {
    if (!currentOrg) return;
    setIsLoading(true);
    try {
      let query = supabase
        .from("approval_rules")
        .select("*")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .order("created_at", { ascending: false });

      if (entityType) {
        query = query.eq("entity_type", entityType);
      }

      const { data, error } = await query;
      if (error) throw error;
      setRules((data || []) as unknown as ApprovalRule[]);
    } catch (error) {
      console.error("Error fetching approval rules:", error);
    } finally {
      setIsLoading(false);
    }
  }, [currentOrg?.id, entityType]);

  useEffect(() => {
    fetchRules();
  }, [fetchRules]);

  const createRule = async (rule: Partial<ApprovalRule>) => {
    if (!currentOrg) throw new Error("No organization");

    const { data, error } = await supabase
      .from("approval_rules")
      .insert({
        organization_id: currentOrg.id,
        business_id: currentBusiness.id,
        entity_type: rule.entity_type || "",
        action_name: rule.action_name || "",
        description: rule.description || null,
        is_active: rule.is_active ?? true,
        condition: rule.condition || {},
        approver_type: rule.approver_type || "specific_user",
        approver_user_id: rule.approver_user_id || null,
        approver_role: rule.approver_role || null,
        approval_mode: rule.approval_mode || "any",
        threshold_field: rule.threshold_field || null,
        threshold_operator: rule.threshold_operator || null,
        threshold_value: rule.threshold_value || null,
      } as any)
      .select()
      .single();

    if (error) throw error;
    toast.success("Approval rule created");
    await fetchRules();
    return data as unknown as ApprovalRule;
  };

  const updateRule = async (id: string, updates: Partial<ApprovalRule>) => {
    const { error } = await supabase
      .from("approval_rules")
      .update(updates as any)
      .eq("id", id);

    if (error) throw error;
    toast.success("Approval rule updated");
    await fetchRules();
  };

  const deleteRule = async (id: string) => {
    const { error } = await supabase
      .from("approval_rules")
      .delete()
      .eq("id", id);

    if (error) throw error;
    toast.success("Approval rule deleted");
    await fetchRules();
  };

  const toggleRule = async (id: string) => {
    const rule = rules.find(r => r.id === id);
    if (rule) {
      await updateRule(id, { is_active: !rule.is_active } as any);
    }
  };

  return {
    rules,
    isLoading,
    createRule,
    updateRule,
    deleteRule,
    toggleRule,
    refetch: fetchRules,
  };
}
