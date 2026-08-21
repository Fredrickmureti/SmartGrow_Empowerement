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
  /** NULL = the rule applies to every branch of the business (AR-6). */
  branch_id: string | null;
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

/** What an author may submit. Scope and identity are stamped by the server. */
export type ReconciliationRuleInput = Omit<
  ReconciliationRule,
  | "id"
  | "organization_id"
  | "business_id"
  | "match_count"
  | "last_matched_at"
  | "created_at"
  | "updated_at"
>;

/** One line the executor declined to act on, and why. */
export interface RuleSkip {
  bank_transaction_id: string;
  rule_id: string | null;
  reason: string;
}

export interface ApplyRulesResult {
  processed: number;
  matched: number;
  posted: number;
  skipped: RuleSkip[];
}

/**
 * The executor's refusal vocabulary, written for an accountant. A rule that
 * declines to act is doing its job — documents outrank rules (ADR-0147 §6).
 */
export const RULE_SKIP_REASONS: Record<string, string> = {
  DOCUMENT_CANDIDATE_EXISTS:
    "An invoice, bill or recorded payment can explain this line, so the rule stood down.",
  LINE_ALREADY_EXPLAINED: "This line is already matched or has a proposal waiting for a decision.",
  AMBIGUOUS_RULE_MATCH: "Two rules of equal priority claim this line — give one a higher priority.",
  AMBIGUOUS_NOT_AUTO_POSTED:
    "The evidence was ambiguous, so the rule left a proposal instead of posting.",
  RULE_HAS_NO_COUNTERPART_ACCOUNT: "The rule has no account to post to.",
};

export function describeRuleSkip(reason: string): string {
  return RULE_SKIP_REASONS[reason] ?? reason;
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
    async (rule: ReconciliationRuleInput) => {
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
    async (id: string, updates: Partial<ReconciliationRuleInput>) => {
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
   *
   * The executor returns what it did *and* what it refused to do. A refusal is
   * the interesting half: a rule that stood down because a document explains
   * the line is the control working, so the reasons are surfaced rather than
   * swallowed (ADR-0147 §6).
   */
  const applyRules = useCallback(
    async (bankAccountId: string, maxRows = 200): Promise<ApplyRulesResult> => {
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
        const raw = (data ?? {}) as Partial<ApplyRulesResult>;
        const result: ApplyRulesResult = {
          processed: raw.processed ?? 0,
          matched: raw.matched ?? 0,
          posted: raw.posted ?? 0,
          skipped: (raw.skipped ?? []) as RuleSkip[],
        };
        toast({
          title: "Reconciliation rules applied",
          description:
            `${result.matched} of ${result.processed} lines matched a rule` +
            (result.posted > 0 ? `, ${result.posted} posted` : ", all left as proposals") +
            (result.skipped.length > 0 ? `. ${result.skipped.length} left for review.` : "."),
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
