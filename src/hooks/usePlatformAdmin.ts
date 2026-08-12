import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { usePlatformIdentity } from "@/contexts/PlatformIdentityContext";
import { toPlatformUsd, sumPlatformUsd } from "@/services/fx/platformUsd";

export interface PlatformStats {
  totalOrganizations: number;
  totalUsers: number;
  // Platform-billing KPIs (always normalised to USD).
  totalRevenue: number; // lifetime succeeded subscription_payments, USD
  mrr: number; // monthly recurring revenue from active orgs, USD
  arr: number; // annualised, USD
  activeSubscriptions: number;
  trialingSubscriptions: number;
  cancelledSubscriptions: number;
  payingOrganizations: number;
  recentOrganizations: Array<{
    id: string;
    name: string;
    slug: string;
    created_at: string;
    memberCount: number;
  }>;
  organizationGrowth: Array<{ month: string; count: number }>;
  userGrowth: Array<{ month: string; count: number }>;
  subscriptionStatusBreakdown: Array<{ name: string; value: number; color: string }>;
}


export function usePlatformAdmin() {
  const { isPlatformAdmin, platformRole, isChecking, refresh } = usePlatformIdentity();
  const [stats, setStats] = useState<PlatformStats | null>(null);
  const [isLoadingStats, setIsLoadingStats] = useState(false);

  const fetchPlatformStats = async () => {
    if (!isPlatformAdmin) return;

    setIsLoadingStats(true);
    try {
      const [
        { count: orgCount },
        { count: userCount },
        { data: orgs },
        { data: payments },
        { data: plans },
        { data: rates },
      ] = await Promise.all([
        supabase.from("organizations").select("*", { count: "exact", head: true }),
        supabase.from("profiles").select("*", { count: "exact", head: true }),
        supabase
          .from("organizations")
          .select("id, subscription_status, is_suspended, subscription_plan_id, created_at"),
        supabase
          .from("subscription_payments")
          .select("organization_id, amount, currency, status, payment_date:created_at"),
        supabase
          .from("platform_subscription_plans")
          .select("id, price_monthly, price_yearly, currency, billing_period"),
        supabase
          .from("platform_exchange_rates" as any)
          .select("from_currency, to_currency, rate")
          .eq("is_active", true),
      ]);

      const ratesArr = ((rates as any) || []) as Array<{ from_currency: string; to_currency: string; rate: number }>;

      // ---- Platform revenue (lifetime, USD) ----
      const succeeded = (payments || []).filter(
        (p: any) => p.status === "succeeded" || p.status === "completed",
      );
      // Amounts whose currency has no rate on file are excluded, not counted
      // at 1:1 (ADR 0136).
      const revenueSum = sumPlatformUsd(
        succeeded.map((p: any) => ({ amount: Number(p.amount || 0), currency: p.currency })),
        ratesArr,
      );
      if (revenueSum.unconvertible > 0) {
        console.warn(
          `[usePlatformAdmin] ${revenueSum.unconvertible} payment(s) excluded from revenue: no USD rate on file`,
        );
      }
      const totalRevenue = revenueSum.total;
      const payingOrganizations = new Set(succeeded.map((p: any) => p.organization_id)).size;

      // ---- MRR / ARR from active orgs * their plan price ----
      const planById = new Map<string, any>();
      (plans || []).forEach((p: any) => planById.set(p.id, p));

      let mrr = 0;
      let activeSubscriptions = 0;
      let trialingSubscriptions = 0;
      let cancelledSubscriptions = 0;
      (orgs || []).forEach((org: any) => {
        const status = org.subscription_status;
        if (status === "active" && !org.is_suspended) activeSubscriptions++;
        else if (status === "trialing") trialingSubscriptions++;
        else if (status === "cancelled" || status === "expired") cancelledSubscriptions++;

        if (status === "active" && !org.is_suspended && org.subscription_plan_id) {
          const plan = planById.get(org.subscription_plan_id);
          if (!plan) return;
          const monthly =
            plan.billing_period === "yearly"
              ? Number(plan.price_yearly || 0) / 12
              : Number(plan.price_monthly || 0);
          mrr += toPlatformUsd(monthly, plan.currency, ratesArr) ?? 0;
        }
      });
      const arr = mrr * 12;

      // ---- Recent organizations w/ member count ----
      const { data: recentRaw } = await supabase
        .from("organizations")
        .select(`id, name, slug, created_at, user_roles(count)`)
        .order("created_at", { ascending: false })
        .limit(10);
      const recentOrganizations = (recentRaw || []).map((org: any) => ({
        id: org.id,
        name: org.name,
        slug: org.slug,
        created_at: org.created_at,
        memberCount: org.user_roles?.[0]?.count || 0,
      }));

      // ---- Growth (last 6 months) ----
      const sixMonthsAgo = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString();
      const { data: orgGrowthData } = await supabase
        .from("organizations")
        .select("created_at")
        .gte("created_at", sixMonthsAgo);
      const { data: userGrowthData } = await supabase
        .from("profiles")
        .select("created_at")
        .gte("created_at", sixMonthsAgo);

      const orgGrowth = calculateMonthlyGrowth(orgGrowthData || []);
      const userGrowth = calculateMonthlyGrowth(userGrowthData || []);

      // ---- Subscription status breakdown for the pie ----
      const noSub =
        (orgCount || 0) - activeSubscriptions - trialingSubscriptions - cancelledSubscriptions;
      const subscriptionStatusBreakdown = [
        { name: "Active", value: activeSubscriptions, color: "hsl(142, 76%, 36%)" },
        { name: "Trialing", value: trialingSubscriptions, color: "hsl(38, 92%, 50%)" },
        { name: "Cancelled", value: cancelledSubscriptions, color: "hsl(0, 84%, 60%)" },
        { name: "No subscription", value: Math.max(0, noSub), color: "hsl(var(--muted))" },
      ].filter((s) => s.value > 0);

      setStats({
        totalOrganizations: orgCount || 0,
        totalUsers: userCount || 0,
        totalRevenue,
        mrr,
        arr,
        activeSubscriptions,
        trialingSubscriptions,
        cancelledSubscriptions,
        payingOrganizations,
        recentOrganizations,
        organizationGrowth: orgGrowth,
        userGrowth,
        subscriptionStatusBreakdown,
      });
    } catch (error) {
      console.error("Error fetching platform stats:", error);
    } finally {
      setIsLoadingStats(false);
    }
  };

  const calculateMonthlyGrowth = (data: Array<{ created_at: string }>) => {
    const months: Record<string, number> = {};
    const now = new Date();
    for (let i = 5; i >= 0; i--) {
      const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = date.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
      months[key] = 0;
    }
    data.forEach((item) => {
      const date = new Date(item.created_at);
      const key = date.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
      if (months.hasOwnProperty(key)) months[key]++;
    });
    return Object.entries(months).map(([month, count]) => ({ month, count }));
  };

  return {
    isPlatformAdmin,
    platformRole,
    isChecking,
    stats,
    isLoadingStats,
    fetchPlatformStats,
    refreshAdminStatus: refresh,
  };
}
