/**
 * useCheapestPlanForApp — resolves the cheapest active plan that includes
 * a given app, so upgrade copy can show real plan name + price instead of
 * the generic "a higher plan" placeholder.
 *
 * Backed by the `cheapest_plan_for_app(p_app_id)` SQL function. Cached for
 * 10 minutes — plan composition rarely changes during a session.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface CheapestPlanForApp {
  plan_id: string;
  plan_name: string;
  price_monthly: number | null;
  currency: string;
}

function formatPrice(amount: number | null, currency: string): string | null {
  if (amount == null) return null;
  const symbol =
    currency === "USD" ? "$" :
    currency === "EUR" ? "€" :
    currency === "GBP" ? "£" :
    `${currency} `;
  const display = amount % 1 === 0 ? amount.toFixed(0) : amount.toFixed(2);
  return `${symbol}${display}/mo`;
}

export function useCheapestPlanForApp(appId: string | null | undefined) {
  const query = useQuery({
    queryKey: ["cheapest-plan-for-app", appId],
    enabled: !!appId,
    staleTime: 10 * 60 * 1000,
    queryFn: async (): Promise<CheapestPlanForApp | null> => {
      if (!appId) return null;
      const { data, error } = await (supabase as any).rpc("cheapest_plan_for_app", {
        p_app_id: appId,
      });
      if (error) throw error;
      // RPC returns a setof — Supabase JS returns it as an array.
      const row = Array.isArray(data) ? data[0] : data;
      if (!row) return null;
      return {
        plan_id: row.plan_id,
        plan_name: row.plan_name,
        price_monthly:
          row.price_monthly == null ? null : Number(row.price_monthly),
        currency: row.currency || "USD", // architecture-allow: display-only fallback — platform plan prices are USD
      };
    },
  });

  const plan = query.data ?? null;
  return {
    plan,
    isLoading: query.isLoading,
    /**
     * Human-readable label, e.g. "Professional ($29/mo)".
     * Returns "a higher plan" as a graceful fallback while loading or when
     * no plan currently includes the app (addon-only case).
     */
    label: plan
      ? plan.price_monthly
        ? `${plan.plan_name} (${formatPrice(plan.price_monthly, plan.currency)})`
        : plan.plan_name
      : "a higher plan",
  };
}
