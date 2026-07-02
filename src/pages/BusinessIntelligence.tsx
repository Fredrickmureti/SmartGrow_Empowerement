/**
 * Business Intelligence Page — Redesigned
 * 
 * GL-sourced analytics, operational signals, and period-close readiness.
 * All financial metrics come from posted journal entries (single source of truth).
 * Operational metrics (AR aging, bank balances) are clearly labeled.
 * 
 * Sections:
 * 1. Financial Position (GL-sourced)
 * 2. Performance Trends (GL-sourced)
 * 3. Operational Signals (hybrid, labeled)
 * 4. Period-Close Readiness
 */

import { ReportsLayout } from "@/apps/reports/ReportsLayout";
import { useGLIntelligence } from "@/hooks/useGLIntelligence";
import { useCurrency } from "@/hooks/useCurrency";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  Loader2,
  TrendingUp,
  TrendingDown,
  AlertTriangle,
  CheckCircle2,
  Clock,
  BarChart3,
  Wallet,
  ArrowUpRight,
  ArrowDownRight,
  ChevronRight,
  ShieldCheck,
  FileX2,
  AlertCircle,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
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
} from "recharts";
import type { OperationalSignal, PeriodCloseItem } from "@/hooks/useGLIntelligence";

export default function BusinessIntelligence() {
  const { data, isLoading, error } = useGLIntelligence();
  const { formatCurrency, baseCurrency } = useCurrency();
  const navigate = useNavigate();

  if (isLoading) {
    return (
      <ReportsLayout>
        <div className="flex items-center justify-center min-h-[400px]">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </ReportsLayout>
    );
  }

  if (error || !data) {
    return (
      <ReportsLayout>
        <div className="flex flex-col items-center justify-center min-h-[400px] text-muted-foreground gap-2">
          <FileX2 className="h-8 w-8" />
          <p>Unable to load intelligence data. Ensure journal entries exist.</p>
        </div>
      </ReportsLayout>
    );
  }

  const { position, trends, signals, closeReadiness, summary } = data;
  const fmt = (v: number) => formatCurrency(v, baseCurrency);

  const getSeverityColor = (severity: string) => {
    switch (severity) {
      case "critical": return "text-destructive";
      case "warning": return "text-yellow-600 dark:text-yellow-400";
      default: return "text-primary";
    }
  };

  const getSeverityBadge = (severity: string) => {
    switch (severity) {
      case "critical": return "destructive" as const;
      case "warning": return "secondary" as const;
      default: return "outline" as const;
    }
  };

  const getStatusIcon = (status: PeriodCloseItem["status"]) => {
    switch (status) {
      case "ok": return <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />;
      case "warning": return <Clock className="h-4 w-4 text-yellow-600 dark:text-yellow-400" />;
      case "action_needed": return <AlertCircle className="h-4 w-4 text-destructive" />;
    }
  };

  return (
    <ReportsLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="page-header">
          <div>
            <h1 className="page-title flex items-center gap-2">
              <BarChart3 className="h-6 w-6" />
              Business Intelligence
            </h1>
            <p className="text-muted-foreground text-sm">
              GL-sourced analytics and operational signals
            </p>
          </div>
          <Badge variant="outline" className="text-xs">
            Source: General Ledger
          </Badge>
        </div>

        {/* Section 1: Financial Position */}
        <div>
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
            Financial Position
          </h2>
          <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
            <Card>
              <CardContent className="pt-4 pb-3">
                <div className="flex items-center gap-2 mb-1">
                  <Wallet className="h-4 w-4 text-muted-foreground" />
                  <span className="text-xs text-muted-foreground">Cash & Equivalents</span>
                </div>
                <p className="text-xl font-bold tabular-nums">{fmt(position.cashAndEquivalents)}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4 pb-3">
                <div className="flex items-center gap-2 mb-1">
                  <ArrowUpRight className="h-4 w-4 text-emerald-600" />
                  <span className="text-xs text-muted-foreground">Receivables</span>
                </div>
                <p className="text-xl font-bold tabular-nums">{fmt(position.totalReceivables)}</p>
                <Badge variant="outline" className="text-[10px] mt-1">Operational</Badge>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4 pb-3">
                <div className="flex items-center gap-2 mb-1">
                  <ArrowDownRight className="h-4 w-4 text-destructive" />
                  <span className="text-xs text-muted-foreground">Payables</span>
                </div>
                <p className="text-xl font-bold tabular-nums">{fmt(position.totalPayables)}</p>
                <Badge variant="outline" className="text-[10px] mt-1">Operational</Badge>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4 pb-3">
                <div className="flex items-center gap-2 mb-1">
                  <TrendingUp className="h-4 w-4 text-primary" />
                  <span className="text-xs text-muted-foreground">Net Working Capital</span>
                </div>
                <p className={`text-xl font-bold tabular-nums ${position.netWorkingCapital >= 0 ? "" : "text-destructive"}`}>
                  {fmt(position.netWorkingCapital)}
                </p>
              </CardContent>
            </Card>
          </div>

          {/* Ratios */}
          <div className="grid gap-4 grid-cols-2 mt-4">
            <Card>
              <CardContent className="pt-4 pb-3 flex items-center justify-between">
                <div>
                  <p className="text-xs text-muted-foreground">Current Ratio</p>
                  <p className="text-lg font-bold tabular-nums">
                    {position.currentRatio >= 999 ? "∞" : position.currentRatio.toFixed(2)}
                  </p>
                </div>
                <Badge variant={position.currentRatio >= 1.5 ? "default" : position.currentRatio >= 1 ? "secondary" : "destructive"}>
                  {position.currentRatio >= 1.5 ? "Healthy" : position.currentRatio >= 1 ? "Adequate" : "Low"}
                </Badge>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4 pb-3 flex items-center justify-between">
                <div>
                  <p className="text-xs text-muted-foreground">Quick Ratio</p>
                  <p className="text-lg font-bold tabular-nums">
                    {position.quickRatio >= 999 ? "∞" : position.quickRatio.toFixed(2)}
                  </p>
                </div>
                <Badge variant={position.quickRatio >= 1 ? "default" : "destructive"}>
                  {position.quickRatio >= 1 ? "Healthy" : "Low"}
                </Badge>
              </CardContent>
            </Card>
          </div>
        </div>

        {/* Section 2: Performance (GL-sourced) */}
        <div>
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
            Performance — 6 Month Trend
            <Badge variant="outline" className="ml-2 text-[10px]">GL-Sourced</Badge>
          </h2>

          {/* KPI summary cards */}
          <div className="grid gap-4 grid-cols-1 sm:grid-cols-3 mb-4">
            <Card>
              <CardContent className="pt-4 pb-3">
                <p className="text-xs text-muted-foreground">Revenue (This Month)</p>
                <p className="text-xl font-bold tabular-nums">{fmt(summary.revenueThisMonth)}</p>
                <div className="flex items-center gap-1 mt-1">
                  {summary.revenueChange >= 0 ? (
                    <TrendingUp className="h-3 w-3 text-emerald-600" />
                  ) : (
                    <TrendingDown className="h-3 w-3 text-destructive" />
                  )}
                  <span className={`text-xs font-medium ${summary.revenueChange >= 0 ? "text-emerald-600" : "text-destructive"}`}>
                    {summary.revenueChange > 0 ? "+" : ""}{summary.revenueChange.toFixed(1)}% vs last month
                  </span>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4 pb-3">
                <p className="text-xs text-muted-foreground">Expenses (This Month)</p>
                <p className="text-xl font-bold tabular-nums">{fmt(summary.expensesThisMonth)}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4 pb-3">
                <p className="text-xs text-muted-foreground">Net Income (This Month)</p>
                <p className={`text-xl font-bold tabular-nums ${summary.netIncomeThisMonth >= 0 ? "" : "text-destructive"}`}>
                  {fmt(summary.netIncomeThisMonth)}
                </p>
              </CardContent>
            </Card>
          </div>

          {/* Charts */}
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Revenue vs Expenses</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="h-[250px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={trends}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                      <XAxis dataKey="month" className="text-xs" tick={{ fontSize: 11 }} />
                      <YAxis className="text-xs" tick={{ fontSize: 11 }} />
                      <Tooltip
                        formatter={(value: number) => fmt(value)}
                        contentStyle={{
                          backgroundColor: "hsl(var(--card))",
                          border: "1px solid hsl(var(--border))",
                          borderRadius: "8px",
                          fontSize: "12px",
                        }}
                      />
                      <Area type="monotone" dataKey="revenue" stroke="hsl(142, 76%, 36%)" fill="hsl(142, 76%, 36%, 0.15)" name="Revenue" />
                      <Area type="monotone" dataKey="expenses" stroke="hsl(0, 84%, 60%)" fill="hsl(0, 84%, 60%, 0.15)" name="Expenses" />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Net Income by Month</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="h-[250px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={trends}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                      <XAxis dataKey="month" className="text-xs" tick={{ fontSize: 11 }} />
                      <YAxis className="text-xs" tick={{ fontSize: 11 }} />
                      <Tooltip
                        formatter={(value: number) => fmt(value)}
                        contentStyle={{
                          backgroundColor: "hsl(var(--card))",
                          border: "1px solid hsl(var(--border))",
                          borderRadius: "8px",
                          fontSize: "12px",
                        }}
                      />
                      <Bar dataKey="netIncome" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} name="Net Income" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>

        {/* Section 3: Operational Signals */}
        {signals.length > 0 && (
          <div>
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
              Operational Signals
            </h2>
            <div className="grid gap-3 md:grid-cols-2">
              {signals.map((signal) => (
                <Card key={signal.id} className="border-l-4" style={{
                  borderLeftColor: signal.severity === "critical" ? "hsl(var(--destructive))" :
                    signal.severity === "warning" ? "hsl(38, 92%, 50%)" : "hsl(var(--primary))"
                }}>
                  <CardContent className="pt-4 pb-3">
                    <div className="flex items-start justify-between">
                      <div className="flex items-start gap-2">
                        <AlertTriangle className={`h-4 w-4 mt-0.5 ${getSeverityColor(signal.severity)}`} />
                        <div>
                          <p className="text-sm font-medium">{signal.label}</p>
                          <p className="text-xs text-muted-foreground mt-0.5">{signal.description}</p>
                          <Badge variant="outline" className="text-[10px] mt-1.5">
                            Source: {signal.source === "gl" ? "General Ledger" : "Operational Data"}
                          </Badge>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge variant={getSeverityBadge(signal.severity)} className="tabular-nums">
                          {fmt(Number(signal.value))}
                        </Badge>
                        {signal.actionPath && (
                          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => navigate(signal.actionPath!)}>
                            <ChevronRight className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        )}

        {/* Section 4: Period-Close Readiness */}
        <div>
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3 flex items-center gap-2">
            <ShieldCheck className="h-4 w-4" />
            Period-Close Readiness
          </h2>
          <Card>
            <CardContent className="pt-4 pb-2">
              <div className="space-y-3">
                {closeReadiness.map((item) => (
                  <div key={item.id} className="flex items-center justify-between py-1">
                    <div className="flex items-center gap-3">
                      {getStatusIcon(item.status)}
                      <div>
                        <p className="text-sm font-medium">{item.label}</p>
                        <p className="text-xs text-muted-foreground">{item.detail}</p>
                      </div>
                    </div>
                    <Badge variant={
                      item.status === "ok" ? "outline" :
                      item.status === "warning" ? "secondary" : "destructive"
                    }>
                      {item.status === "ok" ? "Ready" : item.status === "warning" ? "Review" : "Action Needed"}
                    </Badge>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Footer */}
        <p className="text-xs text-muted-foreground text-center pt-2">
          Financial metrics sourced from posted journal entries via General Ledger. Operational metrics (AR/AP) from invoice and bill records.
        </p>
      </div>
    </ReportsLayout>
  );
}
