import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { ContactPreviewDrawer } from "@/components/contacts/ContactPreviewDrawer";
import { ClickableEntity } from "@/components/common/ClickableEntity";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Loader2, FileText, ShoppingCart, CreditCard, ArrowRight, AlertCircle, Clock, TrendingUp, Users, ReceiptText, Undo2 } from "lucide-react";
import { useCurrency } from "@/hooks/useCurrency";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranch } from "@/contexts/BranchContext";
import { CompanyScopeGate } from "@/components/reports/CompanyScopeGate";
import { ScopeBadge } from "@/components/common/ScopeBadge";
import { useDashboardComposition } from "@/hooks/useDashboardComposition";
import { DashboardSetupGuide } from "@/components/dashboard/DashboardSetupGuide";
import { fetchGLTotals } from "@/services/gl/fetchGLTotals";
import { supabase } from "@/integrations/supabase/client";
import { InvoiceIntegrityPanel } from "@/components/sales/InvoiceIntegrityPanel";
import { format, subMonths, startOfMonth, endOfMonth, startOfYear } from "date-fns";
import { useQuery } from "@tanstack/react-query";
import { AGING_BUCKET_LABELS, type AgingBucketKey } from "@/services/finance/aging";


const DATE_RANGES = [
  { value: "this_month", label: "This Month" },
  { value: "last_month", label: "Last Month" },
  { value: "last_3_months", label: "Last 3 Months" },
  { value: "ytd", label: "Year to Date" },
  { value: "all", label: "All Time" },
];

function getDateRange(rangeKey: string) {
  const now = new Date();
  switch (rangeKey) {
    case "this_month":
      return { start: startOfMonth(now), end: endOfMonth(now) };
    case "last_month": {
      const lm = subMonths(now, 1);
      return { start: startOfMonth(lm), end: endOfMonth(lm) };
    }
    case "last_3_months":
      return { start: startOfMonth(subMonths(now, 2)), end: endOfMonth(now) };
    case "ytd":
      return { start: startOfYear(now), end: now };
    default:
      return null; // all time
  }
}

interface DashboardKPIs {
  pipeline: { draft: number; sent: number; overdue: number; paid: number };
  period_paid_count: number;
  receivable: {
    total: number;
    open_amount?: number;
    overdue_amount: number;
    overdue_count: number;
    credit_balance: number;
  };
  aging: Record<AgingBucketKey, number>;

  estimates: { total: number; accepted: number; open: number };
  sales_orders_pending: number;
  sales_orders_partial?: number;
  credit_notes: { count: number; total: number };
  payments: { count: number; total: number; applied?: number; unapplied?: number };
  top_customers: Array<{ contact_id: string; name: string; invoice_count: number; total_revenue: number }>;
  recent_payments: Array<{ id: string; amount: number; applied_amount?: number; payment_date: string; contact_id: string | null; contact_name: string | null }>;
  meta?: {
    as_of: string;
    period_from: string;
    period_to: string;
    mixed_currency: boolean;
    currency_count: number;
  };
}


/**
 * Sales Module Dashboard — Server-side aggregated KPIs
 */
export default function SalesDashboard() {
  const navigate = useNavigate();
  const [dateRange, setDateRange] = useState("this_month");
  const [contactDrawerOpen, setContactDrawerOpen] = useState(false);
  const [contactDrawerId, setContactDrawerId] = useState<string | null>(null);
  const { formatCurrency } = useCurrency();
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();

  const orgId = currentOrg?.id;
  const businessId = currentBusiness?.id || null;
  const composition = useDashboardComposition();
  // Sales surface highlights only the gaps that block invoicing.
  const salesGaps = composition.setupGaps.filter((g) =>
    g === "customers" || g === "invoices" || g === "products"
  );
  // Branch source-of-truth = BranchContext. The canonical scope switcher
  // (ScopeBadge → ContextSwitcherSheet) mutates it; this dashboard simply
  // reflects whatever the user has chosen there. Removes the duplicated
  // local <Select branchFilter> that previously lived here.
  const { currentBranch } = useBranch();
  const branchId = currentBranch?.id ?? null;
  const range = getDateRange(dateRange);
  const dateFrom = range ? format(range.start, "yyyy-MM-dd") : null;
  const dateTo = range ? format(range.end, "yyyy-MM-dd") : null;

  // Server-side KPIs via RPC
  const { data: kpis, isLoading: kpisLoading, error: kpisError, refetch: refetchKpis, isFetching: kpisFetching } = useQuery({
    queryKey: ["sales-dashboard-kpis", orgId, businessId, branchId, dateRange],
    queryFn: async (): Promise<DashboardKPIs> => {
      const { data, error } = await supabase.rpc("get_sales_dashboard_kpis" as any, {
        p_org_id: orgId!,
        p_business_id: businessId,
        p_date_from: dateFrom,
        p_date_to: dateTo,
        p_branch_id: branchId,
      } as any);
      if (error) throw error;
      return data as unknown as DashboardKPIs;
    },
    enabled: !!orgId,
    staleTime: 30_000,
    // Sales audit Phase 1: auth may not be hydrated on first paint → 42501.
    // Retry a few times so the page recovers automatically instead of showing
    // a destructive error card.
    retry: (failureCount, err: any) => {
      const msg = err?.message || "";
      const code = err?.code || "";
      const isAuthWarming = code === "42501" || /auth required|forbidden/i.test(msg);
      if (isAuthWarming) return failureCount < 3;
      return failureCount < 1;
    },
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 4000),
  });

  // GL Revenue for the period (separate call since GL aggregation is its own service)
  const [glRevenue, setGlRevenue] = useState<number | null>(null);
  const [glError, setGlError] = useState(false);
  const [glReloadKey, setGlReloadKey] = useState(0);
  useEffect(() => {
    if (!orgId) return;
    const now = new Date();
    const r = getDateRange(dateRange);
    const df = r ? format(r.start, "yyyy-MM-dd") : "1900-01-01";
    const dt = r ? format(r.end, "yyyy-MM-dd") : format(now, "yyyy-MM-dd");
    setGlRevenue(null);
    setGlError(false);
    fetchGLTotals(orgId, df, dt, businessId, branchId)
      .then(gl => { setGlRevenue(gl.revenue); setGlError(false); })
      .catch(() => { setGlRevenue(null); setGlError(true); });
  }, [orgId, businessId, branchId, dateRange, glReloadKey]);


  // Sales audit Phase 1: distinguish three load states cleanly.
  // (a) Auth/org not ready yet → soft spinner.
  if (!orgId || kpisLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="flex flex-col items-center gap-2 text-muted-foreground">
          <Loader2 className="h-8 w-8 animate-spin" />
          <p className="text-sm">{!orgId ? "Loading workspace…" : "Loading sales overview…"}</p>
        </div>
      </div>
    );
  }

  // (b) Real RPC failure (network, schema cache, permissions after retries).
  //     The RPC always returns a populated object on success, so kpis === undefined here means a true error.
  if (kpisError || !kpis) {
    const message = kpisError instanceof Error ? kpisError.message : "Failed to load sales dashboard.";
    const code = (kpisError as any)?.code;
    const isSchemaCacheMiss = /404|not.?found|PGRST202|schema cache/i.test(message);
    const isAuthWarming = code === "42501" || /auth required|forbidden/i.test(message);

    // Auth still warming up after retries — softer message, not destructive.
    if (isAuthWarming) {
      return (
        <div className="flex items-center justify-center py-20">
          <div className="flex flex-col items-center gap-3 text-muted-foreground">
            <Loader2 className="h-8 w-8 animate-spin" />
            <p className="text-sm">Verifying workspace access…</p>
            <Button variant="outline" size="sm" onClick={() => refetchKpis()} disabled={kpisFetching}>
              {kpisFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : "Retry"}
            </Button>
          </div>
        </div>
      );
    }

    return (
      <div className="flex items-center justify-center py-20">
        <Card className="max-w-lg w-full border-destructive/40">
          <CardHeader>
            <div className="flex items-center gap-2">
              <AlertCircle className="h-5 w-5 text-destructive" />
              <CardTitle className="text-lg">Couldn't load Sales dashboard</CardTitle>
            </div>
            <CardDescription className="mt-2 break-words">{message}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {isSchemaCacheMiss && (
              <p className="text-xs text-muted-foreground">
                The dashboard RPC is temporarily unreachable (schema cache). This usually clears within a few seconds — try again.
              </p>
            )}
            <Button onClick={() => refetchKpis()} disabled={kpisFetching}>
              {kpisFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : "Retry"}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // (c) Success path — KPIs may be all-zero for a fresh workspace; downstream
  //     cards already render gracefully with zero values, so no separate
  //     "empty state" component is needed.


  const periodRevenue = glRevenue ?? 0;
  const conversionRate = kpis.estimates.total > 0
    ? Math.round((kpis.estimates.accepted / kpis.estimates.total) * 100)
    : 0;
  const cashApplied = kpis.payments.applied ?? kpis.payments.total;
  const cashUnapplied = kpis.payments.unapplied ?? 0;
  const asOfLabel = kpis.meta?.as_of
    ? format(new Date(kpis.meta.as_of), "MMM d, yyyy")
    : "today";
  const periodLabel = DATE_RANGES.find((r) => r.value === dateRange)?.label ?? "period";

  /** Carry the active scope + period into every drill-down target. */
  const withScope = (path: string) => {
    const [base, existing] = path.split("?");
    const params = new URLSearchParams(existing ?? "");
    if (businessId) params.set("business", businessId);
    if (branchId) params.set("branch", branchId);
    if (dateFrom) params.set("from", dateFrom);
    if (dateTo) params.set("to", dateTo);
    const qs = params.toString();
    return qs ? `${base}?${qs}` : base;
  };
  const go = (path: string) => navigate(withScope(path));


  return (
    <CompanyScopeGate reportName="Sales overview">
    <>
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
        <div className="space-y-2">
          <h1 className="page-title">Sales Overview</h1>
          <p className="text-sm text-muted-foreground">
            Invoice pipeline, quotations, and revenue at a glance
          </p>
          <ScopeBadge />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={dateRange} onValueChange={setDateRange}>
            <SelectTrigger className="w-[180px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DATE_RANGES.map(r => (
                <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Accountant attention panel — Wave 3 */}
      <InvoiceIntegrityPanel />

      {salesGaps.length > 0 && <DashboardSetupGuide gaps={salesGaps} />}

      {kpis.meta?.mixed_currency && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-muted-foreground">
          <AlertCircle className="h-4 w-4 shrink-0 text-amber-600" />
          <span>
            Receivables span {kpis.meta.currency_count} currencies. Balances and aging are
            shown converted to your base currency.
          </span>
        </div>
      )}

      {/* Primary KPIs — gated; cashier/operations don't see revenue KPIs. */}
      {composition.allowsWidget("sales.kpis") && (
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="border-l-4 border-l-emerald-500 cursor-pointer hover:shadow-md transition-shadow" onClick={() => go("/sales/invoices?status=paid")}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Revenue (GL, posted)</CardTitle>
            <CardDescription className="text-xs">{periodLabel}</CardDescription>
          </CardHeader>
          <CardContent>
            {glError ? (
              <div className="space-y-1">
                <div className="text-sm font-medium text-destructive">Unavailable</div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={(e) => { e.stopPropagation(); setGlReloadKey((k) => k + 1); }}
                >
                  Retry
                </Button>
              </div>
            ) : glRevenue === null ? (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span className="text-sm">Loading…</span>
              </div>
            ) : (
              <>
                <div className="text-2xl font-bold text-primary">{formatCurrency(periodRevenue)}</div>
                <p className="text-xs text-muted-foreground mt-1">{kpis.period_paid_count} paid invoices</p>
              </>
            )}
          </CardContent>
        </Card>

        <Card className="border-l-4 border-l-blue-500 cursor-pointer hover:shadow-md transition-shadow" onClick={() => go("/sales/payments")}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Cash Applied</CardTitle>
            <CardDescription className="text-xs">{periodLabel}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-primary">{formatCurrency(cashApplied)}</div>
            <p className="text-xs text-muted-foreground mt-1">
              {kpis.payments.count} payments
              {cashUnapplied > 0 && <> · {formatCurrency(cashUnapplied)} unapplied</>}
            </p>
          </CardContent>
        </Card>

        <Card className="border-l-4 border-l-amber-500 cursor-pointer hover:shadow-md transition-shadow" onClick={() => go("/sales/invoices?status=open")}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Outstanding Receivable</CardTitle>
            <CardDescription className="text-xs">as of {asOfLabel}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-primary">{formatCurrency(kpis.receivable.total)}</div>
            <p className="text-xs text-muted-foreground mt-1">
              {kpis.receivable.overdue_count > 0 ? (
                <span className="text-destructive">{kpis.receivable.overdue_count} overdue ({formatCurrency(kpis.receivable.overdue_amount)})</span>
              ) : "No overdue invoices"}
            </p>
            {kpis.receivable.credit_balance > 0 && (
              <p className="text-xs text-muted-foreground mt-0.5">
                net of {formatCurrency(kpis.receivable.credit_balance)} customer credit
              </p>
            )}
          </CardContent>
        </Card>

        <Card className="border-l-4 border-l-purple-500 cursor-pointer hover:shadow-md transition-shadow" onClick={() => go("/sales/estimates")}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Quote Conversion</CardTitle>
            <CardDescription className="text-xs">{periodLabel}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-primary">{conversionRate}%</div>
            <p className="text-xs text-muted-foreground mt-1">{kpis.estimates.accepted} of {kpis.estimates.total} quotes won</p>
          </CardContent>
        </Card>
      </div>

      )}

      {/* Action-Oriented Task Cards — visible to executive/sales/accountant/operations. */}
      {composition.allowsWidget("sales.pipeline") && (
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
        <Card
          className={`cursor-pointer hover:shadow-md transition-shadow ${kpis.pipeline.draft > 0 ? "border-l-4 border-l-amber-400" : ""}`}
          onClick={() => kpis.pipeline.draft > 0 && go("/sales/invoices?status=draft")}
        >
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-1.5">
              <Clock className="h-4 w-4 text-amber-500" /> Invoices to Confirm
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold ${kpis.pipeline.draft > 0 ? "text-amber-600" : "text-muted-foreground"}`}>{kpis.pipeline.draft}</div>
            <p className="text-xs text-muted-foreground">draft invoices pending confirmation</p>
          </CardContent>
        </Card>

        <Card
          className={`cursor-pointer hover:shadow-md transition-shadow ${kpis.pipeline.overdue > 0 ? "border-l-4 border-l-destructive" : ""}`}
          onClick={() => kpis.pipeline.overdue > 0 && go("/sales/invoices?status=overdue")}
        >
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-1.5">
              <AlertCircle className="h-4 w-4 text-destructive" /> Overdue Follow-up
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold ${kpis.pipeline.overdue > 0 ? "text-destructive" : "text-muted-foreground"}`}>{kpis.pipeline.overdue}</div>
            <p className="text-xs text-muted-foreground">{formatCurrency(kpis.receivable.overdue_amount)} outstanding</p>
          </CardContent>
        </Card>

        <Card
          className={`cursor-pointer hover:shadow-md transition-shadow ${kpis.sales_orders_pending > 0 ? "border-l-4 border-l-blue-400" : ""}`}
          onClick={() => kpis.sales_orders_pending > 0 && go("/sales/orders?fulfillment=open")}
        >
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-1.5">
              <ShoppingCart className="h-4 w-4 text-blue-500" /> Orders to Fulfill
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold ${kpis.sales_orders_pending > 0 ? "text-blue-600" : "text-muted-foreground"}`}>{kpis.sales_orders_pending}</div>
            <p className="text-xs text-muted-foreground">
              with quantities still open to deliver
              {(kpis.sales_orders_partial ?? 0) > 0 && <> · {kpis.sales_orders_partial} partly delivered</>}
            </p>
          </CardContent>
        </Card>

        <Card
          className={`cursor-pointer hover:shadow-md transition-shadow ${kpis.estimates.open > 0 ? "border-l-4 border-l-indigo-400" : ""}`}
          onClick={() => kpis.estimates.open > 0 && go("/sales/estimates")}
        >
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-1.5">
              <FileText className="h-4 w-4 text-indigo-500" /> Open Quotes
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold ${kpis.estimates.open > 0 ? "text-indigo-600" : "text-muted-foreground"}`}>{kpis.estimates.open}</div>
            <p className="text-xs text-muted-foreground">awaiting customer response</p>
          </CardContent>
        </Card>

      </div>
      )}

      {/* Secondary KPIs */}
      {composition.allowsWidget("sales.kpis") && (
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2">
        <Card className="cursor-pointer hover:shadow-md transition-shadow" onClick={() => go("/sales/credit-notes")}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-1.5">
              <Undo2 className="h-4 w-4" /> Credit Notes
            </CardTitle>
            <CardDescription className="text-xs">{periodLabel}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{kpis.credit_notes.count}</div>
            <p className="text-xs text-muted-foreground">{formatCurrency(kpis.credit_notes.total)} total</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-1.5">
              <FileText className="h-4 w-4" /> Estimate Conversion
            </CardTitle>
            <CardDescription className="text-xs">{periodLabel}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{kpis.estimates.accepted}</div>
            <p className="text-xs text-muted-foreground">of {kpis.estimates.total} quotes won ({conversionRate}%)</p>
          </CardContent>
        </Card>

      </div>
      )}

      {(composition.allowsWidget("sales.pipeline") || composition.allowsWidget("sales.aging")) && (
      <div className="grid gap-6 grid-cols-1 lg:grid-cols-2">
        {composition.allowsWidget("sales.pipeline") && (
        /* Invoice Pipeline */
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Invoice Pipeline</CardTitle>
            <CardDescription>Status breakdown of all invoices (as of {asOfLabel})</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <div className="text-center p-3 rounded-lg bg-muted/50 cursor-pointer hover:bg-muted transition-colors" onClick={() => go("/sales/invoices?status=draft")}>
                <div className="text-2xl font-bold">{kpis.pipeline.draft}</div>
                <div className="text-xs text-muted-foreground mt-1 flex items-center justify-center gap-1">
                  <Clock className="h-3 w-3" /> Draft
                </div>
              </div>
              <div className="text-center p-3 rounded-lg bg-muted/50 cursor-pointer hover:bg-muted transition-colors" onClick={() => go("/sales/invoices?status=sent")}>
                <div className="text-2xl font-bold">{kpis.pipeline.sent}</div>
                <div className="text-xs text-muted-foreground mt-1">Sent / Viewed</div>
              </div>
              <div className="text-center p-3 rounded-lg bg-muted/50 cursor-pointer hover:bg-muted transition-colors" onClick={() => go("/sales/invoices?status=overdue")}>
                <div className="text-2xl font-bold text-destructive">{kpis.pipeline.overdue}</div>
                <div className="text-xs text-muted-foreground mt-1 flex items-center justify-center gap-1">
                  <AlertCircle className="h-3 w-3" /> Overdue
                </div>
              </div>
              <div className="text-center p-3 rounded-lg bg-muted/50 cursor-pointer hover:bg-muted transition-colors" onClick={() => go("/sales/invoices?status=paid")}>
                <div className="text-2xl font-bold text-emerald-600">{kpis.pipeline.paid}</div>
                <div className="text-xs text-muted-foreground mt-1">Paid</div>
              </div>
            </div>
          </CardContent>
        </Card>
        )}

        {composition.allowsWidget("sales.aging") && (
        /* Receivables Aging */
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Receivables Aging</CardTitle>
            <CardDescription>Base-currency balances by aging bucket, as of {asOfLabel}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {[
                { label: AGING_BUCKET_LABELS.not_due, value: kpis.aging.not_due, color: "bg-emerald-500", aging: "not_due" },
                { label: `${AGING_BUCKET_LABELS.current} overdue`, value: kpis.aging.current, color: "bg-amber-500", aging: "current" },
                { label: AGING_BUCKET_LABELS.days30, value: kpis.aging.days30, color: "bg-orange-500", aging: "days30" },
                { label: AGING_BUCKET_LABELS.days60, value: kpis.aging.days60, color: "bg-red-400", aging: "days60" },
                { label: AGING_BUCKET_LABELS.days90, value: kpis.aging.days90, color: "bg-destructive", aging: "days90" },
              ].map(bucket => (

                <div
                  key={bucket.label}
                  className={`flex items-center justify-between rounded-md px-2 py-1.5 -mx-2 ${bucket.value > 0 ? "cursor-pointer hover:bg-muted/50 transition-colors" : ""}`}
                  onClick={() => bucket.value > 0 && go(`/sales/collections?aging=${bucket.aging}`)}
                >
                  <div className="flex items-center gap-2">
                    <div className={`w-3 h-3 rounded-full ${bucket.color}`} />
                    <span className="text-sm">{bucket.label}</span>
                  </div>
                  <span className={`text-sm font-medium ${bucket.value > 0 ? "" : "text-muted-foreground"}`}>
                    {formatCurrency(bucket.value)}
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
        )}
      </div>
      )}

      {composition.allowsWidget("sales.topCustomers") && (
      <div className="grid gap-6 grid-cols-1 lg:grid-cols-2">
        {/* Top Customers */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-1.5">
              <Users className="h-4 w-4" /> Top Customers
            </CardTitle>
            <CardDescription>Invoiced net of credit notes · {periodLabel}</CardDescription>
          </CardHeader>
          <CardContent>
            {kpis.top_customers.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">No paid invoices in this period</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Customer</TableHead>
                    <TableHead className="text-right">Invoices</TableHead>
                    <TableHead className="text-right">Revenue</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {kpis.top_customers.map((c, i) => (
                    <TableRow key={i}>
                      <TableCell className="font-medium">
                        {c.contact_id ? (
                          <ClickableEntity onClick={() => { setContactDrawerId(c.contact_id); setContactDrawerOpen(true); }}>
                            {c.name}
                          </ClickableEntity>
                        ) : c.name}
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground">{c.invoice_count}</TableCell>
                      <TableCell className="text-right font-medium">{formatCurrency(c.total_revenue)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {/* Recent Payments */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-1.5">
              <CreditCard className="h-4 w-4" /> Recent Payments
            </CardTitle>
            <CardDescription>Latest customer payments · {periodLabel}</CardDescription>
          </CardHeader>
          <CardContent>
            {kpis.recent_payments.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">No payments recorded yet</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Customer</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {kpis.recent_payments.map((p) => (
                    <TableRow
                      key={p.id}
                      className="cursor-pointer hover:bg-muted/30"
                      onClick={() => go(`/sales/payments?id=${p.id}`)}
                    >
                      <TableCell className="font-medium">
                        {p.contact_name ? (
                          <ClickableEntity onClick={(e?: React.MouseEvent) => {
                            e?.stopPropagation?.();
                            if (p.contact_id) { setContactDrawerId(p.contact_id); setContactDrawerOpen(true); }
                          }}>
                            {p.contact_name}
                          </ClickableEntity>
                        ) : "—"}
                      </TableCell>
                      <TableCell className="text-muted-foreground">{format(new Date(p.payment_date), "MMM d")}</TableCell>
                      <TableCell className="text-right font-medium text-emerald-600">+{formatCurrency(p.amount)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
      )}

      {/* Quick Actions */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Quick Actions</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => navigate("/sales/invoices?action=create")}>
              <FileText className="h-4 w-4 mr-1" />
              Create Invoice
            </Button>
            <Button size="sm" variant="outline" onClick={() => navigate("/sales/estimates?action=create")}>
              <ReceiptText className="h-4 w-4 mr-1" />
              Create Estimate
            </Button>
            <Button size="sm" variant="outline" onClick={() => navigate("/sales/payments")}>
              <CreditCard className="h-4 w-4 mr-1" />
              Record Payment
            </Button>
            <Button variant="outline" size="sm" onClick={() => navigate("/sales/invoices")}>
              Invoices <ArrowRight className="h-3 w-3 ml-1" />
            </Button>
            <Button variant="outline" size="sm" onClick={() => navigate("/sales/orders")}>
              Sales Orders <ArrowRight className="h-3 w-3 ml-1" />
            </Button>
            <Button variant="outline" size="sm" onClick={() => navigate("/sales/credit-notes")}>
              Credit Notes <ArrowRight className="h-3 w-3 ml-1" />
            </Button>
            <Button variant="outline" size="sm" onClick={() => navigate("/sales/statements")}>
              Statements <ArrowRight className="h-3 w-3 ml-1" />
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>

    <ContactPreviewDrawer
      open={contactDrawerOpen}
      onOpenChange={setContactDrawerOpen}
      contactId={contactDrawerId}
    />
    </>
    </CompanyScopeGate>
  );
}
