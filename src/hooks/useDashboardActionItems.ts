/**
 * useDashboardActionItems — aggregates "what should I do" signals for the
 * dashboard command strip. Each item resolves to a clickable chip pointing
 * deep into the right module with the active dashboard scope preserved
 * (via withScope on the consuming component).
 *
 * Counts are intentionally cheap (HEAD count queries). Each query is
 * gated by app install + permission upstream — this hook only fires when
 * there is a current organization.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { useDashboardScope } from "./useDashboardScope";

export interface DashboardActionItems {
  overdueInvoices: number;
  billsDueSoon: number;
  lowStock: number;
  unreconciledTxns: number;
}

const ZERO: DashboardActionItems = {
  overdueInvoices: 0,
  billsDueSoon: 0,
  lowStock: 0,
  unreconciledTxns: 0,
};

export function useDashboardActionItems(opts: {
  hasSales: boolean;
  hasPurchases: boolean;
  hasInventory: boolean;
  hasFinance: boolean;
}) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const scope = useDashboardScope();

  const orgId = currentOrg?.id ?? null;
  const businessId = currentBusiness?.id ?? null;
  const branchId = scope.kind === "branch_only" ? scope.branchId : null;
  const enabled = !!orgId && !!businessId && scope.isReady;

  return useQuery({
    queryKey: [
      "dashboard-action-items",
      orgId,
      businessId,
      scope.kind,
      branchId,
      opts,
    ],
    enabled,
    staleTime: 60_000,
    queryFn: async (): Promise<DashboardActionItems> => {
      if (!orgId || !businessId) return ZERO;

      const today = new Date().toISOString().slice(0, 10);
      const in7 = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);

      const applyScope = <T extends { eq: any }>(q: T): T => {
        let next: any = (q as any).eq("organization_id", orgId).eq("business_id", businessId);
        if (branchId) next = next.eq("branch_id", branchId);
        return next;
      };

      const tasks: Array<Promise<number>> = [];

      // Overdue invoices: status sent/partial/viewed AND due_date < today.
      tasks.push(
        (async () => {
          if (!opts.hasSales) return 0;
          try {
            const q = supabase
              .from("invoices")
              .select("id", { count: "exact", head: true })
              .in("status", ["sent", "partial", "viewed", "overdue"])
              .lt("due_date", today);
            const { count } = await applyScope(q as any);
            return count ?? 0;
          } catch {
            return 0;
          }
        })(),
      );

      // Bills due in the next 7 days (not yet paid).
      tasks.push(
        (async () => {
          if (!opts.hasPurchases) return 0;
          try {
            const q = supabase
              .from("bills")
              .select("id", { count: "exact", head: true })
              .in("status", ["received", "partial", "overdue"])
              .lte("due_date", in7);
            const { count } = await applyScope(q as any);
            return count ?? 0;
          } catch {
            return 0;
          }
        })(),
      );

      // Low-stock products. Best-effort: tries dedicated view, falls back to 0.
      tasks.push(
        (async () => {
          if (!opts.hasInventory) return 0;
          try {
            const { data, error } = await (supabase as any)
              .from("products")
              .select("id, stock_quantity, reorder_level")
              .eq("organization_id", orgId)
              .gt("reorder_level", 0)
              .limit(1000);
            if (error || !data) return 0;
            return (data as Array<{ stock_quantity: number; reorder_level: number }>)
              .filter((p) => (p.stock_quantity ?? 0) <= (p.reorder_level ?? 0)).length;
          } catch {
            return 0;
          }
        })(),
      );

      // Unreconciled bank transactions.
      tasks.push(
        (async () => {
          if (!opts.hasFinance) return 0;
          try {
            const q = supabase
              .from("bank_transactions" as any)
              .select("id", { count: "exact", head: true })
              .eq("is_reconciled", false);
            const { count } = await applyScope(q as any);
            return count ?? 0;
          } catch {
            return 0;
          }
        })(),
      );

      const [overdueInvoices, billsDueSoon, lowStock, unreconciledTxns] = await Promise.all(tasks);
      return { overdueInvoices, billsDueSoon, lowStock, unreconciledTxns };
    },
  });
}
