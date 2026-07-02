import { useEffect } from "react";
import { usePlatformAdmin } from "@/hooks/usePlatformAdmin";
import { useAdminCurrency } from "@/hooks/useAdminCurrency";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Building2,
  Users,
  FileText,
  DollarSign,
  TrendingUp,
  Loader2,
  RefreshCw,
  Activity,
  PieChart,
  ArrowUpRight,
  ArrowDownRight,
} from "lucide-react";
import { format } from "date-fns";
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
  PieChart as RechartsPie,
  Pie,
  Cell,
} from "recharts";

const COLORS = ["hsl(var(--primary))", "hsl(142, 76%, 36%)", "hsl(38, 92%, 50%)", "hsl(0, 84%, 60%)"];

export default function AdminManagement() {
  const { stats, isLoadingStats, fetchPlatformStats, isPlatformAdmin, isChecking } = usePlatformAdmin();
  const { formatCurrency, displayCurrency } = useAdminCurrency();

  // Fetch stats only after admin status is confirmed
  useEffect(() => {
    if (!isChecking && isPlatformAdmin) {
      fetchPlatformStats();
    }
  }, [isPlatformAdmin, isChecking]);

  // Derived stats — all platform-billing, all USD-normalised inside the hook.
  const avgUsersPerOrg = stats?.totalOrganizations
    ? (stats.totalUsers / stats.totalOrganizations).toFixed(1)
    : "0";
  const payingPct = stats?.totalOrganizations
    ? ((stats.payingOrganizations / stats.totalOrganizations) * 100).toFixed(0)
    : "0";

  return (
    <>
      <div className="p-3 sm:p-6 lg:p-8 space-y-4 sm:space-y-6 lg:space-y-8">
        {/* Page Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 sm:gap-4">
          <div>
            <h1 className="text-xl sm:text-2xl font-bold tracking-tight">Platform Overview</h1>
            <p className="text-xs sm:text-sm text-muted-foreground">
              Monitor your SaaS platform performance and growth
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={fetchPlatformStats}
            disabled={isLoadingStats}
            className="self-start sm:self-auto"
          >
            <RefreshCw className={`mr-2 h-4 w-4 ${isLoadingStats ? "animate-spin" : ""}`} />
            Refresh Data
          </Button>
        </div>

        {isLoadingStats && !stats ? (
          <div className="flex items-center justify-center py-16">
            <div className="flex flex-col items-center gap-4">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
              <p className="text-sm text-muted-foreground">Loading platform statistics...</p>
            </div>
          </div>
        ) : (
          <>
            {/* Key Metrics */}
            <div className="grid gap-3 sm:gap-4 grid-cols-2 lg:grid-cols-4">
              <Card className="relative overflow-hidden">
                <div className="absolute top-0 right-0 w-16 sm:w-20 h-16 sm:h-20 bg-primary/5 rounded-bl-full" />
                <CardHeader className="flex flex-row items-center justify-between space-y-0 p-3 sm:p-6 pb-1 sm:pb-2">
                  <CardDescription className="text-[10px] sm:text-sm">Organizations</CardDescription>
                  <Building2 className="h-3.5 w-3.5 sm:h-4 sm:w-4 text-primary" />
                </CardHeader>
                <CardContent className="p-3 sm:p-6 pt-0">
                  <div className="text-xl sm:text-3xl font-bold">{stats?.totalOrganizations || 0}</div>
                  <p className="text-[10px] sm:text-xs text-muted-foreground mt-1 truncate">
                    Active businesses on platform
                  </p>
                </CardContent>
              </Card>

              <Card className="relative overflow-hidden">
                <div className="absolute top-0 right-0 w-16 sm:w-20 h-16 sm:h-20 bg-blue-500/5 rounded-bl-full" />
                <CardHeader className="flex flex-row items-center justify-between space-y-0 p-3 sm:p-6 pb-1 sm:pb-2">
                  <CardDescription className="text-[10px] sm:text-sm">Total Users</CardDescription>
                  <Users className="h-3.5 w-3.5 sm:h-4 sm:w-4 text-blue-500" />
                </CardHeader>
                <CardContent className="p-3 sm:p-6 pt-0">
                  <div className="text-xl sm:text-3xl font-bold">{stats?.totalUsers || 0}</div>
                  <p className="text-[10px] sm:text-xs text-muted-foreground mt-1 truncate">
                    ~{avgUsersPerOrg} users per org
                  </p>
                </CardContent>
              </Card>

              <Card className="relative overflow-hidden">
                <div className="absolute top-0 right-0 w-16 sm:w-20 h-16 sm:h-20 bg-amber-500/5 rounded-bl-full" />
                <CardHeader className="flex flex-row items-center justify-between space-y-0 p-3 sm:p-6 pb-1 sm:pb-2">
                  <CardDescription className="text-[10px] sm:text-sm">Active Subscriptions</CardDescription>
                  <FileText className="h-3.5 w-3.5 sm:h-4 sm:w-4 text-amber-500" />
                </CardHeader>
                <CardContent className="p-3 sm:p-6 pt-0">
                  <div className="text-xl sm:text-3xl font-bold">{stats?.activeSubscriptions || 0}</div>
                  <p className="text-[10px] sm:text-xs text-muted-foreground mt-1 truncate">
                    {stats?.trialingSubscriptions || 0} trialing · {stats?.cancelledSubscriptions || 0} cancelled
                  </p>
                </CardContent>
              </Card>

              <Card className="relative overflow-hidden col-span-2 lg:col-span-1">
                <div className="absolute top-0 right-0 w-16 sm:w-20 h-16 sm:h-20 bg-green-500/5 rounded-bl-full" />
                <CardHeader className="flex flex-row items-center justify-between space-y-0 p-3 sm:p-6 pb-1 sm:pb-2">
                  <CardDescription className="text-[10px] sm:text-sm">Platform Revenue</CardDescription>
                  <DollarSign className="h-3.5 w-3.5 sm:h-4 sm:w-4 text-green-500" />
                </CardHeader>
                <CardContent className="p-3 sm:p-6 pt-0">
                  <div className="text-xl sm:text-3xl font-bold text-green-600 truncate">
                    {formatCurrency(stats?.totalRevenue || 0)}
                  </div>
                  <p className="text-[10px] sm:text-xs text-muted-foreground mt-1 truncate">
                    Lifetime succeeded subscription payments
                  </p>
                </CardContent>
              </Card>
            </div>

            {/* Recurring revenue summary */}
            <div className="grid gap-3 sm:gap-4 grid-cols-1 sm:grid-cols-3">
              <Card className="bg-gradient-to-br from-green-500/10 to-green-500/5 border-green-500/20">
                <CardHeader className="p-3 sm:p-6 pb-1 sm:pb-2">
                  <CardDescription className="flex items-center gap-2 text-xs sm:text-sm">
                    <ArrowUpRight className="h-3.5 w-3.5 sm:h-4 sm:w-4 text-green-500 shrink-0" />
                    MRR
                  </CardDescription>
                </CardHeader>
                <CardContent className="p-3 sm:p-6 pt-0">
                  <div className="text-lg sm:text-2xl font-bold text-green-600 truncate">
                    {formatCurrency(stats?.mrr || 0)}
                  </div>
                  <p className="text-[10px] sm:text-xs text-muted-foreground mt-1">
                    Monthly recurring revenue
                  </p>
                </CardContent>
              </Card>

              <Card className="bg-gradient-to-br from-primary/10 to-primary/5 border-primary/20">
                <CardHeader className="p-3 sm:p-6 pb-1 sm:pb-2">
                  <CardDescription className="flex items-center gap-2 text-xs sm:text-sm">
                    <TrendingUp className="h-3.5 w-3.5 sm:h-4 sm:w-4 text-primary shrink-0" />
                    ARR
                  </CardDescription>
                </CardHeader>
                <CardContent className="p-3 sm:p-6 pt-0">
                  <div className="text-lg sm:text-2xl font-bold text-primary truncate">
                    {formatCurrency(stats?.arr || 0)}
                  </div>
                  <p className="text-[10px] sm:text-xs text-muted-foreground mt-1">
                    Annualised run rate
                  </p>
                </CardContent>
              </Card>

              <Card className="bg-gradient-to-br from-blue-500/10 to-blue-500/5 border-blue-500/20">
                <CardHeader className="p-3 sm:p-6 pb-1 sm:pb-2">
                  <CardDescription className="flex items-center gap-2 text-xs sm:text-sm">
                    <Activity className="h-3.5 w-3.5 sm:h-4 sm:w-4 shrink-0 text-blue-500" />
                    Paying Organizations
                  </CardDescription>
                </CardHeader>
                <CardContent className="p-3 sm:p-6 pt-0">
                  <div className="text-lg sm:text-2xl font-bold truncate">
                    {stats?.payingOrganizations || 0}
                    <span className="text-sm text-muted-foreground"> / {stats?.totalOrganizations || 0}</span>
                  </div>
                  <p className="text-[10px] sm:text-xs text-muted-foreground mt-1">
                    {payingPct}% of all orgs have paid at least once
                  </p>
                </CardContent>
              </Card>
            </div>

            {/* Growth Charts */}
            <div className="grid gap-4 sm:gap-6 grid-cols-1 lg:grid-cols-2">
              <Card>
                <CardHeader className="p-3 sm:p-6">
                  <CardTitle className="flex items-center gap-2 text-sm sm:text-base">
                    <Building2 className="h-4 w-4 sm:h-5 sm:w-5 text-primary shrink-0" />
                    Organization Growth
                  </CardTitle>
                  <CardDescription className="text-xs sm:text-sm">New organizations registered per month</CardDescription>
                </CardHeader>
                <CardContent className="p-3 sm:p-6 pt-0">
                  {stats?.organizationGrowth && stats.organizationGrowth.length > 0 ? (
                    <div className="h-[200px] sm:h-[280px]">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={stats.organizationGrowth}>
                          <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                          <XAxis dataKey="month" className="text-xs" tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10 }} />
                          <YAxis className="text-xs" allowDecimals={false} tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10 }} width={30} />
                          <Tooltip
                            contentStyle={{
                              backgroundColor: "hsl(var(--card))",
                              border: "1px solid hsl(var(--border))",
                              borderRadius: "8px",
                              fontSize: "12px",
                            }}
                          />
                          <Bar dataKey="count" fill="hsl(var(--primary))" name="Organizations" radius={[4, 4, 0, 0]} />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  ) : (
                    <div className="flex items-center justify-center h-[200px] sm:h-[280px] text-muted-foreground">
                      <div className="text-center">
                        <Building2 className="h-10 w-10 sm:h-12 sm:w-12 mx-auto mb-2 opacity-20" />
                        <p className="text-sm">No growth data available yet</p>
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="p-3 sm:p-6">
                  <CardTitle className="flex items-center gap-2 text-sm sm:text-base">
                    <Users className="h-4 w-4 sm:h-5 sm:w-5 text-blue-500 shrink-0" />
                    User Growth
                  </CardTitle>
                  <CardDescription className="text-xs sm:text-sm">New user registrations per month</CardDescription>
                </CardHeader>
                <CardContent className="p-3 sm:p-6 pt-0">
                  {stats?.userGrowth && stats.userGrowth.length > 0 ? (
                    <div className="h-[200px] sm:h-[280px]">
                      <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={stats.userGrowth}>
                          <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                          <XAxis dataKey="month" className="text-xs" tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10 }} />
                          <YAxis className="text-xs" allowDecimals={false} tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10 }} width={30} />
                          <Tooltip
                            contentStyle={{
                              backgroundColor: "hsl(var(--card))",
                              border: "1px solid hsl(var(--border))",
                              borderRadius: "8px",
                              fontSize: "12px",
                            }}
                          />
                          <Area
                            type="monotone"
                            dataKey="count"
                            stroke="hsl(217, 91%, 60%)"
                            fill="hsl(217, 91%, 60%, 0.2)"
                            name="Users"
                          />
                        </AreaChart>
                      </ResponsiveContainer>
                    </div>
                  ) : (
                    <div className="flex items-center justify-center h-[200px] sm:h-[280px] text-muted-foreground">
                      <div className="text-center">
                        <Users className="h-10 w-10 sm:h-12 sm:w-12 mx-auto mb-2 opacity-20" />
                        <p className="text-sm">No growth data available yet</p>
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* Recent Organizations */}
            <Card>
              <CardHeader className="p-3 sm:p-6">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <CardTitle className="flex items-center gap-2 text-sm sm:text-base">
                      <TrendingUp className="h-4 w-4 sm:h-5 sm:w-5 text-green-500 shrink-0" />
                      Recent Organizations
                    </CardTitle>
                    <CardDescription className="text-xs sm:text-sm">
                      Latest businesses that joined the platform
                    </CardDescription>
                  </div>
                  <Badge variant="secondary" className="text-[10px] sm:text-xs shrink-0">
                    {stats?.recentOrganizations?.length || 0} shown
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="p-0 sm:p-6 sm:pt-0">
                {/* Desktop Table */}
                <div className="hidden md:block rounded-lg border sm:mx-0">
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-muted/50">
                        <TableHead>Organization</TableHead>
                        <TableHead>Slug</TableHead>
                        <TableHead className="text-center">Members</TableHead>
                        <TableHead>Joined</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {stats?.recentOrganizations && stats.recentOrganizations.length > 0 ? (
                        stats.recentOrganizations.map((org) => (
                          <TableRow key={org.id} className="hover:bg-muted/30">
                            <TableCell>
                              <div className="flex items-center gap-3">
                                <div className="h-9 w-9 rounded-lg bg-gradient-to-br from-primary/20 to-primary/10 flex items-center justify-center shrink-0">
                                  <Building2 className="h-4 w-4 text-primary" />
                                </div>
                                <span className="font-medium truncate">{org.name}</span>
                              </div>
                            </TableCell>
                            <TableCell>
                              <Badge variant="outline" className="font-mono text-xs">
                                {org.slug}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-center">
                              <div className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full bg-blue-500/10 text-blue-600 text-sm">
                                <Users className="h-3 w-3" />
                                {org.memberCount}
                              </div>
                            </TableCell>
                            <TableCell className="text-muted-foreground text-sm">
                              {format(new Date(org.created_at), "MMM d, yyyy")}
                            </TableCell>
                          </TableRow>
                        ))
                      ) : (
                        <TableRow>
                          <TableCell colSpan={4} className="text-center text-muted-foreground py-12">
                            <Building2 className="h-12 w-12 mx-auto mb-3 opacity-20" />
                            <p>No organizations found</p>
                            <p className="text-xs mt-1">Organizations will appear here as they join the platform</p>
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </div>

                {/* Mobile Card List */}
                <div className="md:hidden divide-y divide-border">
                  {stats?.recentOrganizations && stats.recentOrganizations.length > 0 ? (
                    stats.recentOrganizations.map((org) => (
                      <div key={org.id} className="flex items-center gap-3 p-3">
                        <div className="h-9 w-9 rounded-lg bg-gradient-to-br from-primary/20 to-primary/10 flex items-center justify-center shrink-0">
                          <Building2 className="h-4 w-4 text-primary" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate">{org.name}</p>
                          <div className="flex items-center gap-2 mt-0.5">
                            <Badge variant="outline" className="font-mono text-[10px] truncate max-w-[120px]">
                              {org.slug}
                            </Badge>
                            <span className="text-[10px] text-muted-foreground shrink-0">
                              {org.memberCount} member{org.memberCount !== 1 ? "s" : ""}
                            </span>
                          </div>
                        </div>
                        <span className="text-[10px] text-muted-foreground shrink-0">
                          {format(new Date(org.created_at), "MMM d")}
                        </span>
                      </div>
                    ))
                  ) : (
                    <div className="text-center text-muted-foreground py-12">
                      <Building2 className="h-10 w-10 mx-auto mb-3 opacity-20" />
                      <p className="text-sm">No organizations found</p>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </>
  );
}
