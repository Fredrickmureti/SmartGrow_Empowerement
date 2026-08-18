import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { toast } from "sonner";

export interface TransactionRule {
  id: string;
  organization_id: string;
  rule_name: string;
  description_pattern: string | null;
  reference_pattern: string | null;
  min_amount: number | null;
  max_amount: number | null;
  transaction_type: string | null;
  target_category: string;
  target_account_id: string | null;
  priority: number | null;
  is_active: boolean | null;
  created_at: string | null;
  updated_at: string | null;
  // R4: New fields for auto-posting
  auto_action: string | null;
  auto_offset_account_id: string | null;
  auto_post: boolean;
  bank_account_id: string | null;
  stop_processing: boolean;
  use_regex: boolean;
}

export interface CreateRuleInput {
  rule_name: string;
  description_pattern?: string;
  reference_pattern?: string;
  min_amount?: number;
  max_amount?: number;
  transaction_type?: string;
  target_category: string;
  target_account_id?: string;
  priority?: number;
  is_active?: boolean;
  auto_action?: string;
  auto_post?: boolean;
  auto_offset_account_id?: string;
  use_regex?: boolean;
  stop_processing?: boolean;
  bank_account_id?: string;
}

export function useTransactionRules() {
  const [rules, setRules] = useState<TransactionRule[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();

  const fetchRules = useCallback(async () => {
    // Guard: transaction_categorization_rules is business-scoped. Without an
    // active business id we'd dereference null and crash the page (Bank Feeds).
    if (!currentOrg?.id || !currentBusiness?.id) {
      setRules([]);
      setIsLoading(false);
      return;
    }

    try {
      setIsLoading(true);
      const { data, error } = await supabase
        .from("transaction_categorization_rules")
        .select("*")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .order("priority", { ascending: false })
        .order("created_at", { ascending: false });

      if (error) throw error;
      setRules((data || []) as unknown as TransactionRule[]);
    } catch (error) {
      console.error("Error fetching transaction rules:", error);
      toast.error("Failed to load transaction rules");
    } finally {
      setIsLoading(false);
    }
  }, [currentOrg?.id, currentBusiness?.id]);

  useEffect(() => {
    fetchRules();
  }, [fetchRules]);

  const createRule = async (input: CreateRuleInput): Promise<TransactionRule | null> => {
    if (!currentBusiness?.id) {
      toast.error("No active business selected");
      return null;
    }

    try {
      setIsSaving(true);
      // Write seam: the server validates permission, scope and account ownership.
      const { error } = await (supabase as any).rpc(
        "transaction_categorization_rule_upsert",
        { _business_id: currentBusiness.id, _payload: input, _id: null },
      );
      if (error) throw error;

      await fetchRules();
      toast.success("Rule created successfully");
      return null;
    } catch (error) {
      console.error("Error creating rule:", error);
      toast.error("Failed to create rule");
      return null;
    } finally {
      setIsSaving(false);
    }
  };

  const updateRule = async (
    id: string,
    updates: Partial<CreateRuleInput>
  ): Promise<boolean> => {
    if (!currentBusiness?.id) {
      toast.error("No active business selected");
      return false;
    }
    try {
      setIsSaving(true);
      const { error } = await (supabase as any).rpc(
        "transaction_categorization_rule_upsert",
        { _business_id: currentBusiness.id, _payload: updates, _id: id },
      );
      if (error) throw error;

      await fetchRules();
      toast.success("Rule updated successfully");
      return true;
    } catch (error) {
      console.error("Error updating rule:", error);
      toast.error("Failed to update rule");
      return false;
    } finally {
      setIsSaving(false);
    }
  };

  const deleteRule = async (id: string): Promise<boolean> => {
    try {
      setIsSaving(true);
      const { error } = await (supabase as any).rpc(
        "transaction_categorization_rule_delete",
        { _id: id },
      );
      if (error) throw error;

      setRules((prev) => prev.filter((rule) => rule.id !== id));
      toast.success("Rule deleted successfully");
      return true;
    } catch (error) {
      console.error("Error deleting rule:", error);
      toast.error("Failed to delete rule");
      return false;
    } finally {
      setIsSaving(false);
    }
  };


  const toggleRuleActive = async (id: string, isActive: boolean): Promise<boolean> => {
    return updateRule(id, { is_active: isActive });
  };

  /**
   * Apply rules to a transaction and return the matching category
   * Returns null if no rule matches
   */
  const applyRulesToTransaction = (
    description: string,
    reference: string | null,
    amount: number,
    transactionType: "credit" | "debit"
  ): { category: string; ruleName: string; confidence: number } | null => {
    const activeRules = rules
      .filter((rule) => rule.is_active)
      .sort((a, b) => (b.priority || 0) - (a.priority || 0));

    for (const rule of activeRules) {
      // Check transaction type
      if (rule.transaction_type && rule.transaction_type !== "both") {
        if (rule.transaction_type !== transactionType) continue;
      }

      // Check amount range
      if (rule.min_amount !== null && amount < rule.min_amount) continue;
      if (rule.max_amount !== null && amount > rule.max_amount) continue;

      // R4: Support regex matching when use_regex is true
      if (rule.description_pattern) {
        const descLower = description.toLowerCase();
        if ((rule as any).use_regex) {
          try {
            const regex = new RegExp(rule.description_pattern, "i");
            if (!regex.test(description)) continue;
          } catch {
            // Invalid regex, fall back to includes
            const patterns = rule.description_pattern.split("|").map((p) => p.trim().toLowerCase());
            if (!patterns.some((pattern) => descLower.includes(pattern))) continue;
          }
        } else {
          const patterns = rule.description_pattern.split("|").map((p) => p.trim().toLowerCase());
          if (!patterns.some((pattern) => descLower.includes(pattern))) continue;
        }
      }

      // Check reference pattern (case-insensitive)
      if (rule.reference_pattern && reference) {
        const patterns = rule.reference_pattern.split("|").map((p) => p.trim().toLowerCase());
        const refLower = reference.toLowerCase();
        const matchesReference = patterns.some((pattern) => refLower.includes(pattern));
        if (!matchesReference) continue;
      }

      // All conditions passed - return match
      return {
        category: rule.target_category,
        ruleName: rule.rule_name,
        confidence: 1.0, // Rule-based matches are high confidence
      };
    }

    return null;
  };

  /**
   * Create a rule from an existing transaction
   */
  const createRuleFromTransaction = async (
    transaction: {
      description: string;
      reference?: string | null;
      amount: number;
      transaction_type: "credit" | "debit";
    },
    targetCategory: string,
    ruleName?: string
  ): Promise<TransactionRule | null> => {
    // Extract a pattern from the description (first significant word)
    const words = transaction.description.split(/\s+/).filter((w) => w.length > 3);
    const pattern = words.slice(0, 2).join(" ").toUpperCase();

    return createRule({
      rule_name: ruleName || `Auto: ${pattern}`,
      description_pattern: pattern,
      transaction_type: transaction.transaction_type,
      target_category: targetCategory,
      is_active: true,
    });
  };

  return {
    rules,
    isLoading,
    isSaving,
    fetchRules,
    createRule,
    updateRule,
    deleteRule,
    toggleRuleActive,
    applyRulesToTransaction,
    createRuleFromTransaction,
  };
}
