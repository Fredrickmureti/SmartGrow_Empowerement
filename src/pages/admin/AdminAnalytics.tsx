import { useState, useEffect } from "react";
import { useAdminCurrency } from "@/hooks/useAdminCurrency";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  TrendingUp,
  DollarSign,
  Building2,
  Users,
  Activity,
  Loader2,
  RefreshCw,
} from "lucide-react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
} from "recharts";
import { format, subMonths, startOfMonth, endOfMonth } from "date-fns";
import { toPlatformUsd, sumPlatformUsd } from "@/services/fx/platformUsd";

interface MonthlyData {
  month: string;
  count: number;
}

interface RevenueData {
  month: string;
  revenue: number; // USD
}

export default function AdminAnalytics() {
  const { formatCurrency } = useAdminCurrency();
  const [isLoading, setIsLoading] = useState(true);
  const [revenueByMonth, setRevenueByMonth] = useState<RevenueData[]>([]);
  const [statusBreakdown, setStatusBreakdown] = useState<
    Array<{ name: string; value: number; color: string }>
  >([]);
  const [orgGrowth, setOrgGrowth] = useState<MonthlyData[]>([]);
  const [totals, setTotals] = useState({
    totalRevenue: 0, // USD lifetime succeeded subscription_payments
    mrr: 0, // USD
    arr: 0, // USD
    totalOrgs: 0,
    totalUsers: 0,
    activeSubscriptions: 0,
  });

  const fetchAnalytics = async () => {
    setIsLoading(true);
    try {
      const [
        { data: payments },
        { data: orgs },
        { count: orgCount },
        { count: userCount },
        { data: plans },
        { data: rates },
      ] = await Promise.all([
        supabase
          .from("subscription_payments")
          .select("amount, currency, status, created_at"),
        supabase
          .from("organizations")
          .select("id, subscription_status, is_suspended, subscription_plan_id, created_at"),
        supabase.from("organizations").select("id", { count: "exact", head: true }),
        supabase.from("profiles").select("id", { count: "exact", head: true }),
        supabase
          .from("platform_subscription_plans")
          .select("id, price_monthly, price_yearly, currency, billing_period"),
        supabase
          .from("platform_exchange_rates" as any)
          .select("from_currency, to_currency, rate")
          .eq("is_active", true),
      ]);

      const ratesArr = ((rates as any) || []) as Array<{
        from_currency: string;
        to_currency: string;
        rate: number;
      }>;

      // ---- Monthly subscription revenue (last 6 months, USD) ----
      const last6Months = Array.from({ length: 6 }, (_, i) => {
        const date = subMonths(new Date(), 5 - i);
        return {
          start: startOfMonth(date),
          end: endOfMonth(date),
          label: format(date, "MMM"),
        };
      });

      const succeeded = (payments || []).filter(
        (p: any) => p.status === "succeeded" || p.status === "completed",
      );

      const monthlyData = last6Months.map(({ start, end, label }) => {
        const monthPayments = succeeded.filter((p: any) => {
          const date = new Date(p.created_at);
          return date >= start && date <= end;
        });
        return {
          month: label,
          revenue: sumPlatformUsd(
            monthPayments.map((p: any) => ({ amount: Number(p.amount || 0), currency: p.currency })),
            ratesArr,
          ).total,
        };
      });
      setRevenueByMonth(monthlyData);

      // ---- Org growth ----
      const orgGrowthData = last6Months.map(({ start, end, label }) => {
        const count = (orgs || []).filter((org: any) => {
          const date = new Date(org.created_at);
          return date >= start && date <= end;
        }).length;
        return { month: label, count };
      });
      setOrgGrowth(orgGrowthData);

      // ---- MRR + status counts ----
      const planById = new Map<string, any>();
      (plans || []).forEach((p: any) => planById.set(p.id, p));

      let mrr = 0;
      let active = 0;
      let trialing = 0;
      let cancelled = 0;
      (orgs || []).forEach((org: any) => {
        const status = org.subscription_status;
        if (status === "active" && !org.is_suspended) active++;
        else if (status === "trialing") trialing++;
        else if (status === "cancelled" || status === "expired") cancelled++;
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

      const noSub = (orgCount || 0) - active - trialing - cancelled;
      setStatusBreakdown(
        [
          { name: "Active", value: active, color: "hsl(142, 76%, 36%)" },
          { name: "Trialing", value: trialing, color: "hsl(38, 92%, 50%)" },
          { name: "Cancelled", value: cancelled, color: "hsl(0, 84%, 60%)" },
          { name: "No subscription", value: Math.max(0, noSub), color: "hsl(var(--muted))" },
        ].filter((s) => s.value > 0),
      );

      // Unconvertible payments are excluded rather than counted at 1:1 (ADR 0136).
      const lifetimeRevenue = sumPlatformUsd(
        succeeded.map((p: any) => ({ amount: Number(p.amount || 0), currency: p.currency })),
        ratesArr,
      ).total;

      setTotals({
        totalRevenue: lifetimeRevenue,
        mrr,
        arr: mrr * 12,
        totalOrgs: orgCount || 0,
        totalUsers: userCount || 0,
        activeSubscriptions: active,
      });
    } catch (error) {
      console.error("Error fetching analytics:", error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchAnalytics();
  }, []);

  return (
    <>
      <div className="p-4 sm:p-6 lg:p-8 space-y-4 sm:space-y-6">
        <div className="page-header">
          <div>
            <h1 className="text-xl sm:text-2xl font-bold tracking-tight">Analytics</h1>
            <p className="text-sm text-muted-foreground">
              Platform billing, subscriptions and growth
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={fetchAnalytics}
            disabled={isLoading}
            className="touch-target self-start sm:self-auto"
          >
            <RefreshCw className={`mr-2 h-4 w-4 ${isLoading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            {/* Summary Cards — platform billing only */}
            <div className="stats-grid">
              <Card className="bg-gradient-to-br from-success/10 to-success/5 border-success/20">
                <CardHeader className="p-4 pb-2 sm:p-6 sm:pb-2">
                  <CardDescription className="flex items-center gap-2 text-xs sm:text-sm">
                    <DollarSign className="h-3.5 w-3.5 sm:h-4 sm:w-4 shrink-0 text-success" />
                    Platform Revenue
                  </CardDescription>
                </CardHeader>
                <CardContent className="p-4 pt-0 sm:p-6 sm:pt-0">
                  <div className="stat-value text-success">
                    {formatCurrency(totals.totalRevenue)}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    Lifetime succeeded subscription payments
                  </p>
                </CardContent>
              </Card>
              <Card className="bg-gradient-to-br from-primary/10 to-primary/5 border-primary/20">
                <CardHeader className="p-4 pb-2 sm:p-6 sm:pb-2">
                  <CardDescription className="flex items-center gap-2 text-xs sm:text-sm">
                    <TrendingUp className="h-3.5 w-3.5 sm:h-4 sm:w-4 shrink-0 text-primary" />
                    MRR
                  </CardDescription>
                </CardHeader>
                <CardContent className="p-4 pt-0 sm:p-6 sm:pt-0">
                  <div className="stat-value text-primary">{formatCurrency(totals.mrr)}</div>
                  <p className="text-xs text-muted-foreground mt-1">
                    ARR {formatCurrency(totals.arr)}
                  </p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="p-4 pb-2 sm:p-6 sm:pb-2">
                  <CardDescription className="flex items-center gap-2 text-xs sm:text-sm">
                    <Activity className="h-3.5 w-3.5 sm:h-4 sm:w-4 shrink-0" />
                    Active Subscriptions
                  </CardDescription>
                </CardHeader>
                <CardContent className="p-4 pt-0 sm:p-6 sm:pt-0">
                  <div className="stat-value">{totals.activeSubscriptions}</div>
                  <p className="text-xs text-muted-foreground mt-1">
                    of {totals.totalOrgs} orgs
                  </p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="p-4 pb-2 sm:p-6 sm:pb-2">
                  <CardDescription className="flex items-center gap-2 text-xs sm:text-sm">
                    <Users className="h-3.5 w-3.5 sm:h-4 sm:w-4 shrink-0" />
                    Total Users
                  </CardDescription>
                </CardHeader>
                <CardContent className="p-4 pt-0 sm:p-6 sm:pt-0">
                  <div className="stat-value">{totals.totalUsers}</div>
                </CardContent>
              </Card>
            </div>

            <div className="grid gap-4 sm:gap-6 grid-cols-1 lg:grid-cols-2">
              {/* Monthly subscription revenue */}
              <Card>
                <CardHeader className="p-4 sm:p-6">
                  <CardTitle className="text-sm sm:text-base flex items-center gap-2">
                    <DollarSign className="h-4 w-4 sm:h-5 sm:w-5 text-success shrink-0" />
                    Subscription Revenue Trend
                  </CardTitle>
                  <CardDescription className="text-xs sm:text-sm">
                    Last 6 months of succeeded subscription payments
                  </CardDescription>
                </CardHeader>
                <CardContent className="p-4 pt-0 sm:p-6 sm:pt-0">
                  <div className="h-[220px] sm:h-[300px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={revenueByMonth}>
                        <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                        <XAxis dataKey="month" tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }} />
                        <YAxis tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }} width={60} />
                        <Tooltip
                          contentStyle={{
                            backgroundColor: "hsl(var(--card))",
                            border: "1px solid hsl(var(--border))",
                            borderRadius: "8px",
                            fontSize: "13px",
                          }}
                          formatter={(value: number) => formatCurrency(value)}
                        />
                        <Area
                          type="monotone"
                          dataKey="revenue"
                          stroke="hsl(142, 76%, 36%)"
                          fill="hsl(142, 76%, 36%, 0.3)"
                          name="Revenue"
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                </CardContent>
              </Card>

              {/* Subscription status breakdown */}
              <Card>
                <CardHeader className="p-4 sm:p-6">
                  <CardTitle className="text-sm sm:text-base flex items-center gap-2">
                    <Activity className="h-4 w-4 sm:h-5 sm:w-5 text-warning shrink-0" />
                    Subscription Status
                  </CardTitle>
                  <CardDescription className="text-xs sm:text-sm">
                    Distribution across organizations
                  </CardDescription>
                </CardHeader>
                <CardContent className="p-4 pt-0 sm:p-6 sm:pt-0">
                  <div className="h-[220px] sm:h-[300px]">
                    {statusBreakdown.length > 0 ? (
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie
                            data={statusBreakdown}
                            cx="50%"
                            cy="50%"
                            innerRadius={45}
                            outerRadius={75}
                            paddingAngle={2}
                            dataKey="value"
                            label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                            fontSize={12}
                          >
                            {statusBreakdown.map((entry, index) => (
                              <Cell key={`cell-${index}`} fill={entry.color} />
                            ))}
                          </Pie>
                          <Tooltip />
                        </PieChart>
                      </ResponsiveContainer>
                    ) : (
                      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                        No subscription data yet
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            </div>

            <Card>
              <CardHeader className="p-4 sm:p-6">
                <CardTitle className="text-sm sm:text-base flex items-center gap-2">
                  <Building2 className="h-4 w-4 sm:h-5 sm:w-5 text-primary shrink-0" />
                  Organization Growth
                </CardTitle>
                <CardDescription className="text-xs sm:text-sm">
                  New organizations per month
                </CardDescription>
              </CardHeader>
              <CardContent className="p-4 pt-0 sm:p-6 sm:pt-0">
                <div className="h-[200px] sm:h-[250px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={orgGrowth}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                      <XAxis dataKey="month" tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }} />
                      <YAxis allowDecimals={false} tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }} width={40} />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: "hsl(var(--card))",
                          border: "1px solid hsl(var(--border))",
                          borderRadius: "8px",
                          fontSize: "13px",
                        }}
                      />
                      <Bar dataKey="count" fill="hsl(var(--primary))" name="Organizations" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </>
  );
}
