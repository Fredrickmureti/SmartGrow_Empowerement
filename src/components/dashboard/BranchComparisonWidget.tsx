// @ts-nocheck - Tables not in auto-generated types
import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/contexts/BusinessContext";
import { useCurrency } from "@/hooks/useCurrency";
import { useViewCurrencyPreference } from "@/hooks/useViewCurrencyPreference";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, TrendingUp, TrendingDown, GitCompare } from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";

interface BranchPerformance {
  branchId: string;
  branchName: string;
  businessName: string;
  revenue: number;
  expenses: number;
  profit: number;
}

export function BranchComparisonWidget() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { formatCurrency, convertCurrency, baseCurrency } = useCurrency();
  const { viewCurrency } = useViewCurrencyPreference();
  const [data, setData] = useState<BranchPerformance[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const displayCurrency = viewCurrency || baseCurrency;
  const displayAmount = (amount: number) => {
    if (displayCurrency !== baseCurrency) {
      const converted = convertCurrency(amount, baseCurrency, displayCurrency);
      if (converted === null) return "—";
      return formatCurrency(converted, displayCurrency);
    }
    return formatCurrency(amount, baseCurrency);
  };

  useEffect(() => {
    if (currentOrg) fetchBranchData();
  }, [currentOrg?.id, currentBusiness?.id]);

  const fetchBranchData = async () => {
    if (!currentOrg) return;
    setIsLoading(true);

    try {
      // Get all branches for this org (or just for the selected business)
      let branchesQuery = supabase
        // SCOPE-EXEMPT: `branches` is workspace-wide (no business_id column)
        .from("branches")
        .select("id, name, business_id, businesses(name)")
        .eq("organization_id", currentOrg.id)
        .eq("is_active", true);
      if (currentBusiness) {
        branchesQuery = branchesQuery.eq("business_id", currentBusiness.id);
      }
      const { data: branches } = await branchesQuery;

      if (!branches || branches.length === 0) {
        setData([]);
        setIsLoading(false);
        return;
      }

      // Get invoices and expenses for the org
      let invoicesQuery = supabase
        .from("invoices")
        .select("total, status, business_id")
        .eq("organization_id", currentOrg.id)
        .eq("status", "paid");
      if (currentBusiness) invoicesQuery = invoicesQuery.eq("business_id", currentBusiness.id);

      let expensesQuery = supabase
        .from("expenses")
        .select("amount, status, business_id")
        .eq("organization_id", currentOrg.id)
        .in("status", ["approved", "paid"]);
      if (currentBusiness) expensesQuery = expensesQuery.eq("business_id", currentBusiness.id);

      const [{ data: invoices }, { data: expenses }] = await Promise.all([
        invoicesQuery,
        expensesQuery,
      ]);

      // Aggregate by business (branches belong to a business)
      const businessMap = new Map<string, { name: string; revenue: number; expenses: number }>();

      branches.forEach((b) => {
        const biz = b.businesses as any;
        if (!businessMap.has(b.business_id)) {
          businessMap.set(b.business_id, {
            name: biz?.name || "Unknown",
            revenue: 0,
            expenses: 0,
          });
        }
      });

      invoices?.forEach((inv) => {
        const entry = businessMap.get(inv.business_id || "");
        if (entry) entry.revenue += inv.total;
      });

      expenses?.forEach((exp) => {
        const entry = businessMap.get(exp.business_id || "");
        if (entry) entry.expenses += exp.amount;
      });

      // Build per-branch performance with business-level aggregation
      const performance: BranchPerformance[] = [];
      const seenBusinesses = new Set<string>();

      branches.forEach((branch) => {
        if (seenBusinesses.has(branch.business_id)) return;
        seenBusinesses.add(branch.business_id);

        const biz = businessMap.get(branch.business_id);
        if (biz) {
          performance.push({
            branchId: branch.business_id,
            branchName: biz.name,
            businessName: biz.name,
            revenue: biz.revenue,
            expenses: biz.expenses,
            profit: biz.revenue - biz.expenses,
          });
        }
      });

      performance.sort((a, b) => b.revenue - a.revenue);
      setData(performance);
    } catch (error) {
      console.error("Error fetching branch comparison data:", error);
    } finally {
      setIsLoading(false);
    }
  };

  // Show comparison only when there are multiple companies under the workspace.
  if (currentBusiness !== null && data.length <= 1) return null;

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <GitCompare className="h-5 w-5 text-primary" />
            Business Comparison
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        </CardContent>
      </Card>
    );
  }

  if (data.length === 0) return null;

  const chartData = data.map((d) => ({
    name: d.branchName.length > 15 ? d.branchName.substring(0, 15) + "…" : d.branchName,
    Revenue: d.revenue,
    Expenses: d.expenses,
    Profit: d.profit,
  }));

  const topPerformer = data[0];
  const worstPerformer = data[data.length - 1];

  return (
    <Card className="col-span-full">
      <CardHeader>
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2 text-base sm:text-lg">
              <GitCompare className="h-5 w-5 shrink-0 text-primary" />
              <span className="truncate">Business Performance Comparison</span>
            </CardTitle>
            <CardDescription className="mt-1 truncate">
              Branches within {currentBusiness?.name || "this company"}
            </CardDescription>
          </div>
          {topPerformer && (
            <Badge variant="secondary" className="bg-green-100 text-green-800 dark:bg-green-900/20 dark:text-green-400 shrink-0 self-start sm:self-auto">
              <TrendingUp className="h-3 w-3 mr-1" />
              Top: {topPerformer.branchName}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Bar Chart */}
        <div className="h-[280px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} margin={{ left: -10, right: 10 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis dataKey="name" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 10 }} tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`} width={50} />
              <Tooltip
                formatter={(value: number) => displayAmount(value)}
                contentStyle={{
                  backgroundColor: "hsl(var(--card))",
                  border: "1px solid hsl(var(--border))",
                  borderRadius: "8px",
                }}
              />
              <Legend />
              <Bar dataKey="Revenue" fill="hsl(142, 76%, 36%)" radius={[4, 4, 0, 0]} />
              <Bar dataKey="Expenses" fill="hsl(0, 84%, 60%)" radius={[4, 4, 0, 0]} />
              <Bar dataKey="Profit" fill="hsl(221, 83%, 53%)" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Summary Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b">
                <th className="text-left py-2 px-3 font-medium text-muted-foreground">Business</th>
                <th className="text-right py-2 px-3 font-medium text-muted-foreground">Revenue</th>
                <th className="text-right py-2 px-3 font-medium text-muted-foreground">Expenses</th>
                <th className="text-right py-2 px-3 font-medium text-muted-foreground">Profit</th>
                <th className="text-right py-2 px-3 font-medium text-muted-foreground">Margin</th>
              </tr>
            </thead>
            <tbody>
              {data.map((d) => {
                const margin = d.revenue > 0 ? ((d.profit / d.revenue) * 100).toFixed(1) : "0.0";
                return (
                  <tr key={d.branchId} className="border-b last:border-0 hover:bg-muted/50">
                    <td className="py-2 px-3 font-medium">{d.branchName}</td>
                    <td className="text-right py-2 px-3 text-green-600">{displayAmount(d.revenue)}</td>
                    <td className="text-right py-2 px-3 text-red-600">{displayAmount(d.expenses)}</td>
                    <td className={`text-right py-2 px-3 font-medium ${d.profit >= 0 ? "text-green-600" : "text-red-600"}`}>
                      {displayAmount(d.profit)}
                    </td>
                    <td className="text-right py-2 px-3">
                      <span className={`inline-flex items-center gap-1 ${Number(margin) >= 0 ? "text-green-600" : "text-red-600"}`}>
                        {Number(margin) >= 0 ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                        {margin}%
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
