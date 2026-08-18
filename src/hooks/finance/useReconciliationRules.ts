import { normalizeError } from "@/services/resilience";
/**
 * useReconciliationRules — bank reconciliation auto-rules.
 *
 * Each rule matches incoming bank transactions by description / reference /
 * amount range / sign and either auto-posts or suggests a counterpart entry.
 * Mirrors Odoo's `account.reconcile.model`.
 *
 * Backed by `public.bank_reconciliation_rules` and the
 * `apply_reconciliation_rules` RPC.
 */
import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";

export interface ReconciliationRule {
  id: string;
  organization_id: string;
  business_id: string;
  bank_account_id: string | null;
  name: string;
  priority: number;
  is_active: boolean;
  description_pattern: string | null;
  description_regex: string | null;
  reference_pattern: string | null;
  amount_min: number | null;
  amount_max: number | null;
  amount_sign: "debit" | "credit" | "any";
  counterpart_contact_id: string | null;
  counterpart_account_id: string;
  journal_book_id: string | null;
  auto_post: boolean;
  description_template: string | null;
  match_count: number;
  last_matched_at: string | null;
  created_at: string;
  updated_at: string;
}

export function useReconciliationRules() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { user } = useAuth();
  const { toast } = useToast();
  const [rules, setRules] = useState<ReconciliationRule[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isApplying, setIsApplying] = useState(false);

  const fetchRules = useCallback(async () => {
    if (!currentOrg?.id || !currentBusiness?.id) {
      setRules([]);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    const { data, error } = await (supabase as any)
      .from("bank_reconciliation_rules")
      .select("*")
      .eq("organization_id", currentOrg.id)
      .eq("business_id", currentBusiness.id)
      .order("priority", { ascending: true });
    if (error) {
      toast({
        title: "Failed to load reconciliation rules",
        description: normalizeError(error).message,
        variant: "destructive",
      });
      setRules([]);
    } else {
      setRules((data ?? []) as ReconciliationRule[]);
    }
    setIsLoading(false);
  }, [currentOrg?.id, currentBusiness?.id, toast]);

  useEffect(() => {
    fetchRules();
  }, [fetchRules]);

  // Write seam: `bank_reconciliation_rule_upsert` / `_delete` own permission,
  // scope stamping and counterpart-account ownership. The browser only submits.
  const createRule = useCallback(
    async (rule: Omit<ReconciliationRule, "id" | "organization_id" | "business_id" | "match_count" | "last_matched_at" | "created_at" | "updated_at">) => {
      if (!currentBusiness?.id) {
        throw new Error("Select a company first");
      }
      const { error } = await (supabase as any).rpc("bank_reconciliation_rule_upsert", {
        _business_id: currentBusiness.id,
        _payload: rule,
        _id: null,
      });
      if (error) throw error;
      await fetchRules();
    },
    [currentBusiness?.id, fetchRules],
  );

  const updateRule = useCallback(
    async (id: string, updates: Partial<ReconciliationRule>) => {
      if (!currentBusiness?.id) {
        throw new Error("Select a company first");
      }
      const { error } = await (supabase as any).rpc("bank_reconciliation_rule_upsert", {
        _business_id: currentBusiness.id,
        _payload: updates,
        _id: id,
      });
      if (error) throw error;
      await fetchRules();
    },
    [currentBusiness?.id, fetchRules],
  );

  const deleteRule = useCallback(
    async (id: string) => {
      const { error } = await (supabase as any).rpc("bank_reconciliation_rule_delete", {
        _id: id,
      });
      if (error) throw error;
      await fetchRules();
    },
    [fetchRules],
  );


  /**
   * Apply all active rules to the unreconciled transactions of a bank account.
   * Returns the number of transactions matched and posted.
   */
  const applyRules = useCallback(
    async (bankAccountId: string, maxRows = 200) => {
      setIsApplying(true);
      try {
        const { data, error } = await (supabase as any).rpc(
          "apply_reconciliation_rules",
          {
            _bank_account_id: bankAccountId,
            _user_id: user?.id ?? null,
            _max_rows: maxRows,
          },
        );
        if (error) throw error;
        const result = (data ?? {}) as {
          processed?: number;
          matched?: number;
        };
        toast({
          title: "Reconciliation rules applied",
          description: `${result.matched ?? 0} of ${result.processed ?? 0} transactions matched and posted.`,
        });
        await fetchRules();
        return result;
      } catch (err: any) {
        toast({
          title: "Failed to apply rules",
          description: normalizeError(err).message,
          variant: "destructive",
        });
        throw err;
      } finally {
        setIsApplying(false);
      }
    },
    [user?.id, toast, fetchRules],
  );

  return {
    rules,
    isLoading,
    isApplying,
    fetchRules,
    createRule,
    updateRule,
    deleteRule,
    applyRules,
  };
}
