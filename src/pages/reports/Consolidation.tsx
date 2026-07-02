/**
 * Cross-Company Comparative View.
 *
 * This is the ONLY legitimate cross-company view in the system. Per industry
 * standards (Odoo, QuickBooks Advanced, Xero), aggregating financial data
 * across legal entities requires intercompany eliminations and currency
 * translation — features that belong to a future Phase 2 consolidation engine.
 *
 * Until that engine ships, we display each company's P&L *side by side* in
 * its own native currency. We do NOT sum across companies, we do NOT do FX
 * translation, and we do NOT eliminate intercompany transactions. The page
 * makes that boundary explicit so accountants and auditors are not misled.
 */
import { useMemo, useState } from "react";
import { PlatformAppLayout } from "@/apps/platform";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { GitMerge, ArrowLeft, AlertTriangle, Info } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useOrganization } from "@/hooks/useOrganization";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { format, startOfMonth, endOfMonth } from "date-fns";
import { ShieldAlert } from "lucide-react";

interface CompanyPnl {
  businessId: string;
  businessName: string;
  currency: string;
  income: number;
  expense: number;
  netIncome: number;
}

/**
 * Per-company P&L computed straight from posted journal_entry_lines so the
 * numbers are always honest (even though we deliberately do not sum them).
 *
 * For every business in the workspace we sum:
 *   income  = SUM(credit) - SUM(debit) over income accounts
 *   expense = SUM(debit)  - SUM(credit) over expense accounts
 *   net     = income - expense
 *
 * Unlike `useFinancialReport` this hook intentionally runs PER BUSINESS and
 * never blends them into a single total — that would require eliminations
 * and FX translation we don't yet support.
 */
function useComparativePnl(dateFrom: string, dateTo: string) {
  const { currentOrg } = useOrganization();
  const { businesses } = useBusinesses();
  const orgId = currentOrg?.id;

  return useQuery({
    queryKey: ["consolidation-comparative-pnl", orgId, dateFrom, dateTo, businesses.map((b) => b.id)],
    enabled: !!orgId && businesses.length > 0,
    queryFn: async (): Promise<CompanyPnl[]> => {
      const results: CompanyPnl[] = [];

      for (const biz of businesses) {
        // 1. Income & expense accounts for this business (or shared)
        const { data: accounts, error: aErr } = await supabase
          .from("accounts")
          .select("id, account_type")
          .eq("organization_id", orgId!)
          .eq("is_active", true)
          .in("account_type", ["income", "expense"])
          .or(`business_id.eq.${biz.id},business_id.is.null`);
        if (aErr) throw aErr;
        if (!accounts?.length) {
          results.push({
            businessId: biz.id,
            businessName: biz.name,
            currency: biz.base_currency || "—",
            income: 0,
            expense: 0,
            netIncome: 0,
          });
          continue;
        }

        const incomeIds = accounts.filter((a) => a.account_type === "income").map((a) => a.id);
        const expenseIds = accounts.filter((a) => a.account_type === "expense").map((a) => a.id);

        // 2. Posted JE lines for this business in the period
        const { data: lines, error: lErr } = await supabase
          .from("journal_entry_lines")
          .select("account_id, debit, credit, journal_entry:journal_entries!inner(date, status, business_id)")
          .eq("journal_entry.business_id", biz.id)
          .eq("journal_entry.status", "posted")
          .gte("journal_entry.date", dateFrom)
          .lte("journal_entry.date", dateTo);
        if (lErr) throw lErr;

        let income = 0;
        let expense = 0;
        for (const ln of lines ?? []) {
          const debit = Number(ln.debit ?? 0);
          const credit = Number(ln.credit ?? 0);
          if (incomeIds.includes(ln.account_id)) income += credit - debit;
          else if (expenseIds.includes(ln.account_id)) expense += debit - credit;
        }

        results.push({
          businessId: biz.id,
          businessName: biz.name,
          currency: biz.base_currency || "—",
          income,
          expense,
          netIncome: income - expense,
        });
      }

      return results;
    },
  });
}

function formatMoney(value: number, currency: string) {
  if (currency === "—") return value.toFixed(2);
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(value);
  } catch {
    return `${currency} ${value.toFixed(2)}`;
  }
}

export default function Consolidation() {
  const navigate = useNavigate();
  const { businesses } = useBusinesses();
  const { userRole } = useOrganization();
  const canViewConsolidation = userRole?.role === "owner" || userRole?.role === "super_admin";

  const today = new Date();
  const [dateFrom, setDateFrom] = useState(format(startOfMonth(today), "yyyy-MM-dd"));
  const [dateTo, setDateTo] = useState(format(endOfMonth(today), "yyyy-MM-dd"));

  const { data: rows, isLoading, error } = useComparativePnl(
    canViewConsolidation ? dateFrom : "",
    canViewConsolidation ? dateTo : "",
  );

  const currencies = useMemo(
    () => Array.from(new Set((rows ?? []).map((r) => r.currency))),
    [rows],
  );
  const mixedCurrency = currencies.length > 1;

  if (!canViewConsolidation) {
    return (
      <PlatformAppLayout>
        <div className="max-w-2xl mx-auto px-4 py-12">
          <Card>
            <CardHeader>
              <div className="flex items-start gap-3">
                <div className="h-10 w-10 rounded-lg bg-destructive/10 flex items-center justify-center shrink-0">
                  <ShieldAlert className="h-5 w-5 text-destructive" />
                </div>
                <div>
                  <CardTitle>Restricted view</CardTitle>
                  <CardDescription>
                    Cross-company comparative reports are limited to workspace
                    Owners and Super Admins because they expose figures from every
                    legal entity in the workspace.
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <Button variant="outline" size="sm" onClick={() => navigate(-1)}>
                <ArrowLeft className="h-4 w-4 mr-2" />
                Go back
              </Button>
            </CardContent>
          </Card>
        </div>
      </PlatformAppLayout>
    );
  }

  return (
    <PlatformAppLayout>
      <div className="max-w-6xl mx-auto px-4 py-6 space-y-6">
        <Button variant="ghost" size="sm" onClick={() => navigate(-1)} className="-ml-2">
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back
        </Button>

        <div className="flex items-start gap-4">
          <div className="h-12 w-12 rounded-xl bg-primary/10 flex items-center justify-center">
            <GitMerge className="h-6 w-6 text-primary" />
          </div>
          <div className="flex-1">
            <h1 className="text-2xl font-bold tracking-tight">Cross-Company Comparative View</h1>
            <p className="text-muted-foreground mt-1">
              Per-company P&amp;L, side by side. Each column stays in its own books and
              currency — no totals, no eliminations.
            </p>
          </div>
        </div>

        <Alert>
          <Info className="h-4 w-4" />
          <AlertDescription className="text-sm">
            <strong>This is not a GAAP/IFRS consolidation.</strong> True consolidated
            statements require intercompany eliminations and FX translation, which live in
            a future Lovable module. Use the columns below to compare companies — do not
            add the figures together.
          </AlertDescription>
        </Alert>

        {mixedCurrency && (
          <Alert variant="default" className="border-warning/50">
            <AlertTriangle className="h-4 w-4 text-warning" />
            <AlertDescription className="text-sm">
              Your companies report in {currencies.length} different currencies
              ({currencies.join(", ")}). Comparing the absolute amounts is misleading
              without FX translation — focus on each company's own trend.
            </AlertDescription>
          </Alert>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Reporting period</CardTitle>
            <CardDescription>Applied to every company column.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-md">
              <div className="space-y-1">
                <Label htmlFor="from">From</Label>
                <Input
                  id="from"
                  type="date"
                  value={dateFrom}
                  onChange={(e) => setDateFrom(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="to">To</Label>
                <Input
                  id="to"
                  type="date"
                  value={dateTo}
                  onChange={(e) => setDateTo(e.target.value)}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {businesses.length === 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>No companies yet</CardTitle>
              <CardDescription>
                Create a company under <strong>Settings → Organization</strong> to start
                using the comparative view.
              </CardDescription>
            </CardHeader>
          </Card>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Profit &amp; Loss — by company</CardTitle>
              <CardDescription>
                Native-currency totals for the selected period.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {error ? (
                <Alert variant="destructive">
                  <AlertDescription>
                    {error instanceof Error ? error.message : "Failed to load report."}
                  </AlertDescription>
                </Alert>
              ) : isLoading ? (
                <div className="space-y-2">
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-8 w-full" />
                  <Skeleton className="h-8 w-full" />
                  <Skeleton className="h-8 w-full" />
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Company</TableHead>
                      <TableHead>Currency</TableHead>
                      <TableHead className="text-right">Income</TableHead>
                      <TableHead className="text-right">Expenses</TableHead>
                      <TableHead className="text-right">Net Income</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(rows ?? []).map((r) => (
                      <TableRow key={r.businessId}>
                        <TableCell className="font-medium">{r.businessName}</TableCell>
                        <TableCell>
                          <Badge variant="outline">{r.currency}</Badge>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatMoney(r.income, r.currency)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatMoney(r.expense, r.currency)}
                        </TableCell>
                        <TableCell
                          className={`text-right tabular-nums font-semibold ${
                            r.netIncome >= 0 ? "text-emerald-600" : "text-destructive"
                          }`}
                        >
                          {formatMoney(r.netIncome, r.currency)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="text-base">What's coming</CardTitle>
            <CardDescription>
              Roadmap for the full consolidation engine.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="list-disc list-inside space-y-1 text-sm text-muted-foreground pl-2">
              <li>FX translation to a chosen presentation currency (CTA reserves)</li>
              <li>Intercompany AR ↔ AP eliminations</li>
              <li>Investment / equity eliminations</li>
              <li>Minority-interest reporting</li>
              <li>Comparative Balance Sheet and Cash-Flow views</li>
            </ul>
          </CardContent>
        </Card>
      </div>
    </PlatformAppLayout>
  );
}
