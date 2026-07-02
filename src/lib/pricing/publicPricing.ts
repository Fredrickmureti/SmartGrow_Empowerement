/**
 * Public pricing snapshot client.
 *
 * Reads anonymous-safe pricing data via the SECURITY DEFINER RPC
 * `get_public_pricing_snapshot()`. This replaces direct `anon` reads of
 * `platform_subscription_plans` and `platform_exchange_rates`, both of
 * which are gated by platform-admin RLS and surface a noisy
 * "permission denied for function is_platform_admin" 401 otherwise.
 *
 * The result is memoized in-module so that the landing page's pricing
 * section and `usePricingCurrency` share a single network request.
 */
import { supabase } from "@/integrations/supabase/client";

export interface PublicPlan {
  id: string;
  name: string;
  description: string | null;
  price_monthly: number;
  price_yearly: number | null;
  features: unknown[];
  is_popular: boolean;
}

export interface PublicRate {
  from_currency: string;
  to_currency: string;
  rate: number;
}

export interface PublicPricingSnapshot {
  plans: PublicPlan[];
  rates: PublicRate[];
}

let cached: Promise<PublicPricingSnapshot> | null = null;

export function fetchPublicPricingSnapshot(): Promise<PublicPricingSnapshot> {
  if (cached) return cached;
  cached = (async () => {
    const { data, error } = await (supabase as any).rpc("get_public_pricing_snapshot");
    if (error) {
      cached = null;
      throw error;
    }
    const payload = (data ?? {}) as Partial<PublicPricingSnapshot>;
    return {
      plans: Array.isArray(payload.plans) ? (payload.plans as PublicPlan[]) : [],
      rates: Array.isArray(payload.rates) ? (payload.rates as PublicRate[]) : [],
    };
  })();
  return cached;
}
