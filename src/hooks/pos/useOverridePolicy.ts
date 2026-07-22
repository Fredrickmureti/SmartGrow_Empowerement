/**
 * useOverridePolicy — resolves whether a POS reversal command needs a
 * manager approval by consulting `pos_override_matrix`.
 *
 * Stage 3 of the POS refund/reversal remediation (see `.lovable/plan.md`).
 *
 * Precedence (matches `assert_manager_override` server-side):
 *   business-scoped row  >  org-default row (business_id IS NULL)
 * If no row exists for `{organization_id, action}` the action is
 * unrestricted — approval is NOT required. This mirrors the server
 * helper's "no enforcement configured" behaviour so the UI never asks
 * for a PIN the RPC would not require.
 *
 * The hook is intentionally read-only: it does not create overrides,
 * it does not call any reversal RPC. Callers wire it into their
 * dispatch flow (open a PIN dialog when `required` is true, then pass
 * the resulting `pos_manager_overrides.id` into the RPC's
 * `p_manager_override_id` argument).
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { POSReversalCommandType } from "@/services/pos/reversal/reasonCodes";

/** Canonical action-code emitted to `assert_manager_override.p_action`. */
export const OVERRIDE_ACTION_FOR_COMMAND: Record<
  POSReversalCommandType,
  string
> = {
  void_sale: "pos_card_void",
  reverse_card_authorization: "pos_card_reverse",
  refund_sale: "pos_payment_session_reverse_tender",
  return_goods: "pos_return_authorization_transition:approved",
  exchange: "pos_return_authorization_transition:approved",
  issue_store_credit: "pos_payment_session_reverse_tender",
};

export interface OverridePolicyFacts {
  organizationId: string | null | undefined;
  businessId: string | null | undefined;
  /** Sale / tender amount used to compare against `threshold_amount`. */
  amount: number;
}

export interface OverridePolicyResult {
  /** True when a matrix row demands an approval for this action + amount. */
  required: boolean;
  /** Threshold configured for the action (0 when no row / no threshold). */
  thresholdAmount: number;
  /** Restricted approver roles; empty means "any approver". */
  restrictedRoles: ReadonlyArray<string>;
  /** Raw action code sent to `assert_manager_override`. */
  actionCode: string;
  /** True when the resolver had no envelope context to query with. */
  facts: OverridePolicyFacts;
}

/**
 * Fetches the effective matrix row for `(action, org, business)` with
 * business-scope precedence, then decides whether the amount crosses
 * the threshold OR the matrix mandates PIN regardless.
 */
export function useOverridePolicy(
  command: POSReversalCommandType,
  facts: OverridePolicyFacts,
) {
  const actionCode = OVERRIDE_ACTION_FOR_COMMAND[command];
  const orgId = facts.organizationId ?? null;
  const bizId = facts.businessId ?? null;
  const amount = Number.isFinite(facts.amount) ? Number(facts.amount) : 0;

  return useQuery<OverridePolicyResult>({
    queryKey: [
      "pos-override-policy",
      actionCode,
      orgId,
      bizId,
      amount,
    ],
    enabled: !!orgId,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("pos_override_matrix")
        .select("business_id, threshold_amount, require_pin, restricted_roles")
        .eq("organization_id", orgId!)
        .eq("action", actionCode)
        .eq("is_active", true);
      if (error) throw error;

      // Precedence: business-scoped > org-default.
      const rows = data ?? [];
      const row =
        rows.find((r) => r.business_id === bizId) ??
        rows.find((r) => r.business_id === null) ??
        null;

      if (!row) {
        return {
          required: false,
          thresholdAmount: 0,
          restrictedRoles: [],
          actionCode,
          facts,
        };
      }

      const threshold = Number(row.threshold_amount ?? 0);
      const required =
        row.require_pin === true || amount > threshold;

      return {
        required,
        thresholdAmount: threshold,
        restrictedRoles: (row.restricted_roles as string[] | null) ?? [],
        actionCode,
        facts,
      };
    },
  });
}
