// @ts-nocheck - Admin tables not in auto-generated types
import { useState, useEffect, useMemo } from "react";
import { useAdminCurrency } from "@/hooks/useAdminCurrency";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  BarChart3,
  Building2,
  Users,
  CreditCard,
  TrendingUp,
  Loader2,
  RefreshCw,
  Download,
  HardDrive,
  ArrowUpRight,
  ArrowDownRight,
  AlertTriangle,
  HeartPulse,
  Puzzle,
  Activity,
} from "lucide-react";
import { StorageMonitorTab } from "@/components/admin/reports/StorageMonitorTab";
import { PaymentsTab } from "@/components/admin/reports/PaymentsTab";
import { FeatureAdoptionTab } from "@/components/admin/reports/FeatureAdoptionTab";
import { ActivityTab } from "@/components/admin/reports/ActivityTab";
import { ReportExportButtons } from "@/components/reports/ReportExportButtons";
import type { ExportConfig } from "@/services/reports/ReportExportService";
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
  Legend,
} from "recharts";
import { format, subMonths, startOfMonth, endOfMonth, differenceInDays } from "date-fns";

interface HealthOrgRow {
  id: string;
  name: string;
  plan: string;
  status: string;
  issue: string;
  severity: "critical" | "warning" | "info";
  detail: string;
}

interface OrgUsageRow {
  id: string;
  name: string;
  plan: string;
  userCount: number;
  maxUsers: number | null;
  storageMb: number;
  maxStorageMb: number | null;
  status: string;
  createdAt: string;
}

const PLAN_COLORS = [
  "hsl(142, 76%, 36%)",
  "hsl(217, 91%, 60%)",
  "hsl(262, 83%, 58%)",
  "hsl(38, 92%, 50%)",
  "hsl(346, 77%, 49%)",
];

export default function AdminReports() {
  const { formatCurrency, convertAmount } = useAdminCurrency();
  const [isLoading, setIsLoading] = useState(true);
  const [period, setPeriod] = useState("6");
  const [revenueData, setRevenueData] = useState<any[]>([]);
  const [planDistribution, setPlanDistribution] = useState<any[]>([]);
  const [orgUsage, setOrgUsage] = useState<OrgUsageRow[]>([]);
  const [subscriptionMetrics, setSubscriptionMetrics] = useState({
    mrr: 0,
    arr: 0,
    totalOrgs: 0,
    activeOrgs: 0,
    trialOrgs: 0,
    expiredOrgs: 0,
    totalUsers: 0,
    avgUsersPerOrg: 0,
    churnRate: 0,
  });
  const [healthData, setHealthData] = useState<HealthOrgRow[]>([]);

  const fetchReportData = async () => {
    setIsLoading(true);
    try {
      const months = parseInt(period);

      // Fetch organizations with plans
      const { data: orgs } = await supabase
        .from("organizations")
        .select("id, name, subscription_plan_id, subscription_status, trial_ends_at, is_suspended, created_at");

      // Fetch plans
      const { data: plans } = await supabase
        .from("platform_subscription_plans")
        .select("id, name, price_monthly, price_per_user_monthly")
        .order("sort_order");

      // Fetch subscription payments
      const { data: payments } = await supabase
        .from("subscription_payments")
        .select("amount, currency, payment_date, status, organization_id");

      // Fetch user counts per org
      const { data: userRoles } = await supabase
        .from("user_roles")
        .select("organization_id, user_id");

      // Build plan map
      const planMap = new Map(plans?.map((p) => [p.id, p]) || []);

      // Calculate plan distribution
      const planCounts: Record<string, number> = {};
      orgs?.forEach((org) => {
        const plan = planMap.get(org.subscription_plan_id);
        const planName = plan?.name || "No Plan";
        planCounts[planName] = (planCounts[planName] || 0) + 1;
      });
      setPlanDistribution(
        Object.entries(planCounts).map(([name, value], i) => ({
          name,
          value,
          color: PLAN_COLORS[i % PLAN_COLORS.length],
        }))
      );

      // Calculate user counts per org
      const userCountsByOrg = new Map<string, number>();
      userRoles?.forEach((role) => {
        const current = userCountsByOrg.get(role.organization_id) || 0;
        userCountsByOrg.set(role.organization_id, current + 1);
      });

      // Build org usage table with real storage
      const orgRows: OrgUsageRow[] = await Promise.all(
        (orgs || []).map(async (org) => {
          const plan = planMap.get(org.subscription_plan_id);
          // Get real storage usage
          let storageMb = 0;
          try {
            const { data: storageData } = await (supabase as any).rpc("get_org_storage_usage_mb", { p_organization_id: org.id });
            storageMb = storageData ?? 0;
          } catch {}
          return {
            id: org.id,
            name: org.name,
            plan: plan?.name || "No Plan",
            userCount: userCountsByOrg.get(org.id) || 0,
            maxUsers: plan ? (plan as any).max_users : null,
            storageMb,
            maxStorageMb: plan ? (plan as any).max_storage_mb : null,
            status: org.is_suspended ? "suspended" : org.subscription_status || "none",
            createdAt: org.created_at,
          };
        })
      );
      setOrgUsage(orgRows.sort((a, b) => b.userCount - a.userCount));

      // Calculate monthly revenue
      const lastNMonths = Array.from({ length: months }, (_, i) => {
        const date = subMonths(new Date(), months - 1 - i);
        return {
          start: startOfMonth(date),
          end: endOfMonth(date),
          label: format(date, "MMM yyyy"),
        };
      });

      const monthlyRevenue = lastNMonths.map(({ start, end, label }) => {
        const monthPayments = payments?.filter((p) => {
          if (p.status !== "succeeded" && p.status !== "completed") return false;
          const date = new Date(p.payment_date);
          return date >= start && date <= end;
        }) || [];
        return {
          month: label,
          revenue: monthPayments.reduce((sum, p) => sum + Number(p.amount || 0), 0),
          count: monthPayments.length,
        };
      });
      setRevenueData(monthlyRevenue);

      // Calculate subscription metrics
      const activeOrgs = orgs?.filter((o) => o.subscription_status === "active" && !o.is_suspended).length || 0;
      const trialOrgs = orgs?.filter((o) => o.subscription_status === "trialing").length || 0;
      const expiredOrgs = orgs?.filter((o) => o.subscription_status === "expired" || o.subscription_status === "cancelled").length || 0;
      const totalUsers = new Set(userRoles?.map((r) => r.user_id) || []).size;

      // Calculate MRR from active orgs
      let mrr = 0;
      orgs?.forEach((org) => {
        if (org.subscription_status === "active" && !org.is_suspended) {
          const plan = planMap.get(org.subscription_plan_id);
          if (plan) {
            const orgUserCount = userCountsByOrg.get(org.id) || 1;
            mrr += Number(plan.price_monthly || 0) + (Number(plan.price_per_user_monthly || 0) * Math.max(0, orgUserCount - 1));
          }
        }
      });

      setSubscriptionMetrics({
        mrr,
        arr: mrr * 12,
        totalOrgs: orgs?.length || 0,
        activeOrgs,
        trialOrgs,
        expiredOrgs,
        totalUsers,
        avgUsersPerOrg: activeOrgs > 0 ? Math.round(totalUsers / activeOrgs) : 0,
        churnRate: (orgs?.length || 0) > 0 ? Math.round((expiredOrgs / (orgs?.length || 1)) * 100) : 0,
      });

      // ── Subscription Health Data ──
      const healthRows: HealthOrgRow[] = [];
      const now = new Date();
      
      (orgs || []).forEach((org: any) => {
        const plan = planMap.get(org.subscription_plan_id);
        const planName = (plan as any)?.name || "No Plan";
        const orgStatus = org.is_suspended ? "suspended" : org.subscription_status || "none";
        const userCount = userCountsByOrg.get(org.id) || 0;
        const maxUsers = (plan as any)?.max_users;

        // Suspended orgs
        if (org.is_suspended) {
          healthRows.push({ id: org.id, name: org.name, plan: planName, status: orgStatus, issue: "Suspended", severity: "critical", detail: "Organization is suspended" });
        }

        // Expired subscriptions
        if (org.subscription_status === "expired" || org.subscription_status === "cancelled") {
          healthRows.push({ id: org.id, name: org.name, plan: planName, status: orgStatus, issue: "Expired", severity: "critical", detail: "Subscription has expired" });
        }

        // Near expiry (within 7 days)
        if (org.subscription_status === "active" && org.subscription_ends_at) {
          const daysLeft = differenceInDays(new Date(org.subscription_ends_at), now);
          if (daysLeft > 0 && daysLeft <= 7) {
            healthRows.push({ id: org.id, name: org.name, plan: planName, status: orgStatus, issue: "Expiring Soon", severity: "warning", detail: `Expires in ${daysLeft} day(s)` });
          }
        }

        // Trial expiring soon
        if (org.subscription_status === "trialing" && org.trial_ends_at) {
          const daysLeft = differenceInDays(new Date(org.trial_ends_at), now);
          if (daysLeft > 0 && daysLeft <= 3) {
            healthRows.push({ id: org.id, name: org.name, plan: planName, status: orgStatus, issue: "Trial Ending", severity: "warning", detail: `Trial expires in ${daysLeft} day(s)` });
          }
        }

        // Over user limit
        if (maxUsers && maxUsers > 0 && userCount > maxUsers) {
          healthRows.push({ id: org.id, name: org.name, plan: planName, status: orgStatus, issue: "Over User Limit", severity: "warning", detail: `${userCount}/${maxUsers} users` });
        }

        // No plan assigned
        if (!org.subscription_plan_id && org.subscription_status !== "trialing") {
          healthRows.push({ id: org.id, name: org.name, plan: planName, status: orgStatus, issue: "No Plan", severity: "info", detail: "No subscription plan assigned" });
        }
      });

      // Sort by severity: critical first
      const severityOrder = { critical: 0, warning: 1, info: 2 };
      healthRows.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);
      setHealthData(healthRows);
    } catch (error) {
      console.error("Error fetching report data:", error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchReportData();
  }, [period]);

  const chartRevenueData = revenueData.map((d) => ({
    month: d.month,
    // `null` = no rate on file for the display currency; the chart plots a gap
    // rather than an unconverted USD figure.
    revenue: convertAmount(d.revenue) ?? null,
    count: d.count,
  }));

  const getRevenueExportConfig = (): ExportConfig => ({
    title: "Platform Revenue Report",
    subtitle: `Last ${period} months`,
    columns: [
      { key: "month", header: "Month" },
      { key: "revenue", header: "Revenue", format: "currency" },
      { key: "count", header: "Payment Count", format: "number" },
    ],
    rows: chartRevenueData,
    generatedAt: new Date(),
  });

  const getSubscriptionsExportConfig = (): ExportConfig => ({
    title: "Subscription Distribution Report",
    columns: [
      { key: "name", header: "Plan Name" },
      { key: "value", header: "Org Count", format: "number" },
      { key: "percentage", header: "Percentage", format: "percent" },
    ],
    rows: planDistribution.map((p) => ({
      name: p.name,
      value: p.value,
      percentage: subscriptionMetrics.totalOrgs > 0 ? Math.round((p.value / subscriptionMetrics.totalOrgs) * 100) : 0,
    })),
    generatedAt: new Date(),
  });

  const getUsageExportConfig = (): ExportConfig => ({
    title: "Organization Usage Report",
    columns: [
      { key: "name", header: "Organization" },
      { key: "plan", header: "Plan" },
      { key: "userCount", header: "Users", format: "number" },
      { key: "maxUsers", header: "Max Users", format: "number" },
      { key: "storageMb", header: "Storage (MB)", format: "number" },
      { key: "status", header: "Status" },
      { key: "createdAt", header: "Created" },
    ],
    rows: orgUsage.map((o) => ({
      name: o.name,
      plan: o.plan,
      userCount: o.userCount,
      maxUsers: o.maxUsers ?? "Unlimited",
      storageMb: Math.round(o.storageMb * 100) / 100,
      status: o.status,
      createdAt: format(new Date(o.createdAt), "yyyy-MM-dd"),
    })),
    generatedAt: new Date(),
  });

  const getHealthExportConfig = (): ExportConfig => ({
    title: "Subscription Health Report",
    columns: [
      { key: "severity", header: "Severity" },
      { key: "name", header: "Organization" },
      { key: "plan", header: "Plan" },
      { key: "issue", header: "Issue" },
      { key: "detail", header: "Details" },
    ],
    rows: healthData,
    generatedAt: new Date(),
  });

  return (
    <>
      <div className="p-4 sm:p-6 lg:p-8 space-y-4 sm:space-y-6">
        {/* Header */}
        <div className="page-header">
          <div>
            <h1 className="text-xl sm:text-2xl font-bold tracking-tight">Platform Reports</h1>
            <p className="text-sm text-muted-foreground">
              Comprehensive revenue, subscription, and usage reports
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Select value={period} onValueChange={setPeriod}>
              <SelectTrigger className="w-[140px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="3">Last 3 months</SelectItem>
                <SelectItem value="6">Last 6 months</SelectItem>
                <SelectItem value="12">Last 12 months</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" onClick={fetchReportData} disabled={isLoading}>
              <RefreshCw className={`mr-2 h-4 w-4 ${isLoading ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          </div>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <Tabs defaultValue="revenue" className="space-y-4 sm:space-y-6">
            <div className="overflow-x-auto scrollbar-hide -mx-3 px-3 sm:-mx-0 sm:px-0 pb-1">
              <TabsList className="inline-flex w-max gap-0.5 h-auto p-0.5 sm:p-1">
                <TabsTrigger value="revenue" className="flex items-center gap-1.5 text-[10px] sm:text-xs lg:text-sm px-2 py-1.5 sm:px-3 sm:py-2 whitespace-nowrap">
                  <CreditCard className="h-3.5 w-3.5 hidden sm:block" />
                  Revenue
                </TabsTrigger>
                <TabsTrigger value="subscriptions" className="flex items-center gap-1.5 text-[10px] sm:text-xs lg:text-sm px-2 py-1.5 sm:px-3 sm:py-2 whitespace-nowrap">
                  <TrendingUp className="h-3.5 w-3.5 hidden sm:block" />
                  Subscriptions
                </TabsTrigger>
                <TabsTrigger value="usage" className="flex items-center gap-1.5 text-[10px] sm:text-xs lg:text-sm px-2 py-1.5 sm:px-3 sm:py-2 whitespace-nowrap">
                  <Building2 className="h-3.5 w-3.5 hidden sm:block" />
                  Org Usage
                </TabsTrigger>
                <TabsTrigger value="health" className="flex items-center gap-1.5 text-[10px] sm:text-xs lg:text-sm px-2 py-1.5 sm:px-3 sm:py-2 whitespace-nowrap">
                  <HeartPulse className="h-3.5 w-3.5 hidden sm:block" />
                  Health
                  {healthData.filter(h => h.severity === "critical").length > 0 && (
                    <Badge variant="destructive" className="ml-1 h-4 min-w-4 px-1 text-[10px]">
                      {healthData.filter(h => h.severity === "critical").length}
                    </Badge>
                  )}
                </TabsTrigger>
                <TabsTrigger value="storage" className="flex items-center gap-1.5 text-[10px] sm:text-xs lg:text-sm px-2 py-1.5 sm:px-3 sm:py-2 whitespace-nowrap">
                  <HardDrive className="h-3.5 w-3.5 hidden sm:block" />
                  Storage
                </TabsTrigger>
                <TabsTrigger value="payments" className="flex items-center gap-1.5 text-[10px] sm:text-xs lg:text-sm px-2 py-1.5 sm:px-3 sm:py-2 whitespace-nowrap">
                  <CreditCard className="h-3.5 w-3.5 hidden sm:block" />
                  Payments
                </TabsTrigger>
                <TabsTrigger value="adoption" className="flex items-center gap-1.5 text-[10px] sm:text-xs lg:text-sm px-2 py-1.5 sm:px-3 sm:py-2 whitespace-nowrap">
                  <Puzzle className="h-3.5 w-3.5 hidden sm:block" />
                  Adoption
                </TabsTrigger>
                <TabsTrigger value="activity" className="flex items-center gap-1.5 text-[10px] sm:text-xs lg:text-sm px-2 py-1.5 sm:px-3 sm:py-2 whitespace-nowrap">
                  <Activity className="h-3.5 w-3.5 hidden sm:block" />
                  Activity
                </TabsTrigger>
              </TabsList>
            </div>

            {/* Revenue Tab */}
            <TabsContent value="revenue" className="space-y-6">
              {/* MRR / ARR Cards */}
              <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
                <Card className="bg-gradient-to-br from-primary/10 to-primary/5 border-primary/20">
                  <CardHeader className="p-4 pb-2">
                    <CardDescription className="flex items-center gap-2 text-xs">
                      <TrendingUp className="h-3.5 w-3.5 text-primary" />
                      Monthly Recurring Revenue
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="p-4 pt-0">
                    <div className="text-2xl font-bold text-primary">{formatCurrency(subscriptionMetrics.mrr)}</div>
                    <p className="text-xs text-muted-foreground mt-1">Based on active subscriptions</p>
                  </CardContent>
                </Card>
                <Card className="bg-gradient-to-br from-success/10 to-success/5 border-success/20">
                  <CardHeader className="p-4 pb-2">
                    <CardDescription className="flex items-center gap-2 text-xs">
                      <ArrowUpRight className="h-3.5 w-3.5 text-success" />
                      Annual Recurring Revenue
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="p-4 pt-0">
                    <div className="text-2xl font-bold text-success">{formatCurrency(subscriptionMetrics.arr)}</div>
                    <p className="text-xs text-muted-foreground mt-1">MRR × 12 projection</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="p-4 pb-2">
                    <CardDescription className="flex items-center gap-2 text-xs">
                      <Building2 className="h-3.5 w-3.5" />
                      Active Organizations
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="p-4 pt-0">
                    <div className="text-2xl font-bold">{subscriptionMetrics.activeOrgs}</div>
                    <p className="text-xs text-muted-foreground mt-1">of {subscriptionMetrics.totalOrgs} total</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="p-4 pb-2">
                    <CardDescription className="flex items-center gap-2 text-xs">
                      <Users className="h-3.5 w-3.5" />
                      Total Users
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="p-4 pt-0">
                    <div className="text-2xl font-bold">{subscriptionMetrics.totalUsers}</div>
                    <p className="text-xs text-muted-foreground mt-1">~{subscriptionMetrics.avgUsersPerOrg} per org avg</p>
                  </CardContent>
                </Card>
              </div>

              {/* Revenue Chart */}
              <Card>
                <CardHeader className="p-4 sm:p-6">
                  <CardTitle className="text-sm sm:text-base flex items-center gap-2">
                    <BarChart3 className="h-4 w-4 text-primary" />
                    Subscription Revenue
                  </CardTitle>
                  <CardDescription className="text-xs sm:text-sm">Revenue from subscription payments</CardDescription>
                </CardHeader>
                <div className="px-4 sm:px-6 pb-2 flex justify-end">
                  <ReportExportButtons getExportConfig={getRevenueExportConfig} formats={["excel", "csv", "pdf"]} compact />
                </div>
                <CardContent className="p-4 pt-0 sm:p-6 sm:pt-0">
                  <div className="h-[250px] sm:h-[300px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={chartRevenueData}>
                        <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                        <XAxis dataKey="month" tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }} />
                        <YAxis tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }} width={60} />
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
                          stroke="hsl(var(--primary))"
                          fill="hsl(var(--primary) / 0.2)"
                          name="Revenue"
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            {/* Subscriptions Tab */}
            <TabsContent value="subscriptions" className="space-y-6">
              <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
                <Card>
                  <CardHeader className="p-4 pb-2">
                    <CardDescription className="text-xs">Active</CardDescription>
                  </CardHeader>
                  <CardContent className="p-4 pt-0">
                    <div className="text-2xl font-bold text-success">{subscriptionMetrics.activeOrgs}</div>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="p-4 pb-2">
                    <CardDescription className="text-xs">Trialing</CardDescription>
                  </CardHeader>
                  <CardContent className="p-4 pt-0">
                    <div className="text-2xl font-bold text-primary">{subscriptionMetrics.trialOrgs}</div>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="p-4 pb-2">
                    <CardDescription className="text-xs">Expired / Cancelled</CardDescription>
                  </CardHeader>
                  <CardContent className="p-4 pt-0">
                    <div className="text-2xl font-bold text-destructive">{subscriptionMetrics.expiredOrgs}</div>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="p-4 pb-2">
                    <CardDescription className="text-xs">Churn Rate</CardDescription>
                  </CardHeader>
                  <CardContent className="p-4 pt-0">
                    <div className="text-2xl font-bold text-warning flex items-center gap-1">
                      {subscriptionMetrics.churnRate}%
                      <ArrowDownRight className="h-4 w-4" />
                    </div>
                  </CardContent>
                </Card>
              </div>

              {/* Plan Distribution */}
              <Card>
                <CardHeader className="p-4 sm:p-6">
                  <CardTitle className="text-sm sm:text-base">Plan Distribution</CardTitle>
                  <CardDescription className="text-xs sm:text-sm">Organizations by subscription plan</CardDescription>
                </CardHeader>
                <div className="px-4 sm:px-6 pb-2 flex justify-end">
                  <ReportExportButtons getExportConfig={getSubscriptionsExportConfig} formats={["excel", "csv", "pdf"]} compact />
                </div>
                <CardContent className="p-4 pt-0 sm:p-6 sm:pt-0">
                  <div className="h-[280px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={planDistribution}
                          cx="50%"
                          cy="50%"
                          innerRadius={50}
                          outerRadius={90}
                          paddingAngle={3}
                          dataKey="value"
                          label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                          fontSize={12}
                        >
                          {planDistribution.map((entry, index) => (
                            <Cell key={`cell-${index}`} fill={entry.color} />
                          ))}
                        </Pie>
                        <Legend />
                        <Tooltip />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            {/* Usage Tab */}
            <TabsContent value="usage" className="space-y-6">
              <Card>
                <CardHeader className="p-4 sm:p-6">
                  <CardTitle className="text-sm sm:text-base flex items-center gap-2">
                    <Building2 className="h-4 w-4" />
                    Organization Usage Overview
                  </CardTitle>
                  <CardDescription className="text-xs sm:text-sm">
                    User counts, storage, and plan details for all organizations
                  </CardDescription>
                </CardHeader>
                <div className="px-4 sm:px-6 pb-2 flex justify-end">
                  <ReportExportButtons getExportConfig={getUsageExportConfig} formats={["excel", "csv", "pdf"]} compact />
                </div>
                <CardContent className="p-4 pt-0 sm:p-6 sm:pt-0">
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Organization</TableHead>
                          <TableHead>Plan</TableHead>
                          <TableHead className="text-center">Users</TableHead>
                          <TableHead className="text-center">Status</TableHead>
                          <TableHead>Created</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {orgUsage.length === 0 ? (
                          <TableRow>
                            <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                              No organizations found
                            </TableCell>
                          </TableRow>
                        ) : (
                          orgUsage.map((org) => (
                            <TableRow key={org.id}>
                              <TableCell className="font-medium">{org.name}</TableCell>
                              <TableCell>
                                <Badge variant="outline" className="text-xs">{org.plan}</Badge>
                              </TableCell>
                              <TableCell className="text-center">
                                <span className={org.maxUsers && org.userCount >= org.maxUsers ? "text-destructive font-medium" : ""}>
                                  {org.userCount}
                                </span>
                                {org.maxUsers && (
                                  <span className="text-muted-foreground">/{org.maxUsers}</span>
                                )}
                              </TableCell>
                              <TableCell className="text-center">
                                <Badge
                                  variant={
                                    org.status === "active" ? "default" :
                                    org.status === "trialing" ? "secondary" :
                                    "destructive"
                                  }
                                  className="text-xs"
                                >
                                  {org.status}
                                </Badge>
                              </TableCell>
                              <TableCell className="text-xs text-muted-foreground">
                                {format(new Date(org.createdAt), "MMM d, yyyy")}
                              </TableCell>
                            </TableRow>
                          ))
                        )}
                      </TableBody>
                    </Table>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            {/* Subscription Health Tab */}
            <TabsContent value="health" className="space-y-6">
              <Card>
                <CardHeader className="p-4 sm:p-6">
                  <CardTitle className="text-sm sm:text-base flex items-center gap-2">
                    <HeartPulse className="h-4 w-4" />
                    Subscription Health
                  </CardTitle>
                  <CardDescription className="text-xs sm:text-sm">
                    Organizations needing attention: expired subs, near-expiry, over-limit users, and suspended accounts
                  </CardDescription>
                </CardHeader>
                <div className="px-4 sm:px-6 pb-2 flex justify-end">
                  <ReportExportButtons getExportConfig={getHealthExportConfig} formats={["excel", "csv", "pdf"]} compact />
                </div>
                <CardContent className="p-4 pt-0 sm:p-6 sm:pt-0">
                  {healthData.length === 0 ? (
                    <div className="text-center py-12 text-muted-foreground">
                      <HeartPulse className="h-10 w-10 mx-auto mb-3 text-green-500" />
                      <p className="font-medium text-foreground">All Clear</p>
                      <p className="text-sm">No subscription health issues detected</p>
                    </div>
                  ) : (
                    <>
                      <div className="flex gap-3 mb-4 flex-wrap">
                        <Badge variant="destructive" className="text-xs">
                          {healthData.filter(h => h.severity === "critical").length} Critical
                        </Badge>
                        <Badge variant="secondary" className="text-xs bg-yellow-500/10 text-yellow-700">
                          {healthData.filter(h => h.severity === "warning").length} Warning
                        </Badge>
                        <Badge variant="outline" className="text-xs">
                          {healthData.filter(h => h.severity === "info").length} Info
                        </Badge>
                      </div>
                      <div className="overflow-x-auto">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Severity</TableHead>
                              <TableHead>Organization</TableHead>
                              <TableHead>Plan</TableHead>
                              <TableHead>Issue</TableHead>
                              <TableHead>Details</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {healthData.map((row, i) => (
                              <TableRow key={`${row.id}-${i}`}>
                                <TableCell>
                                  <Badge
                                    variant={row.severity === "critical" ? "destructive" : row.severity === "warning" ? "secondary" : "outline"}
                                    className={`text-xs ${row.severity === "warning" ? "bg-yellow-500/10 text-yellow-700" : ""}`}
                                  >
                                    {row.severity === "critical" && <AlertTriangle className="h-3 w-3 mr-1" />}
                                    {row.severity}
                                  </Badge>
                                </TableCell>
                                <TableCell className="font-medium">{row.name}</TableCell>
                                <TableCell>
                                  <Badge variant="outline" className="text-xs">{row.plan}</Badge>
                                </TableCell>
                                <TableCell>{row.issue}</TableCell>
                                <TableCell className="text-sm text-muted-foreground">{row.detail}</TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    </>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            {/* Storage Monitor Tab */}
            <TabsContent value="storage" className="space-y-6">
              <StorageMonitorTab orgUsage={orgUsage.map(o => ({
                id: o.id,
                name: o.name,
                plan: o.plan,
                storageMb: o.storageMb,
                maxStorageMb: o.maxStorageMb,
                percentage: o.maxStorageMb && o.maxStorageMb > 0 ? Math.round((o.storageMb / o.maxStorageMb) * 1000) / 10 : 0,
                status: o.status,
              }))} />
            </TabsContent>

            {/* Payments Tab */}
            <TabsContent value="payments" className="space-y-6">
              <PaymentsTab formatCurrency={formatCurrency} />
            </TabsContent>

            {/* Feature Adoption Tab */}
            <TabsContent value="adoption" className="space-y-6">
              <FeatureAdoptionTab />
            </TabsContent>

            {/* Activity Tab */}
            <TabsContent value="activity" className="space-y-6">
              <ActivityTab />
            </TabsContent>
          </Tabs>
        )}
      </div>
    </>
  );
}