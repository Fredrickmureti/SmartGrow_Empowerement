import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranch } from "@/contexts/BranchContext";
import { usePOSOverseer } from "@/hooks/pos/usePOSOverseer";
import { subDays, format } from "date-fns";

export interface CashierPerformance {
  user_id: string;
  user_email: string;
  total_sales: number;
  transaction_count: number;
  avg_transaction: number;
  returns_count: number;
  returns_total: number;
  void_count: number;
  discount_given: number;
  avg_transaction_time_seconds: number;
  cash_over_short: number;
}

export interface FraudIndicator {
  type: "void_pattern" | "return_pattern" | "discount_abuse" | "price_override" | "cash_variance";
  severity: "low" | "medium" | "high";
  user_id: string;
  user_email: string;
  description: string;
  count: number;
  amount: number;
  timestamp: string;
}

export interface ABCProduct {
  id: string;
  name: string;
  category: "A" | "B" | "C";
  revenue: number;
  revenue_percent: number;
  quantity: number;
  cumulative_percent: number;
}

export interface CustomerAnalytics {
  total_customers: number;
  new_customers: number;
  returning_customers: number;
  avg_basket_size: number;
  avg_visits_per_customer: number;
  top_customers: Array<{
    contact_id: string;
    name: string;
    total_spent: number;
    visit_count: number;
    avg_basket: number;
  }>;
}

export interface PaymentMethodBreakdown {
  payment_method: string;
  total_amount: number;
  transaction_count: number;
  percentage: number;
}

export interface TaxSummaryItem {
  tax_rate: number;
  taxable_amount: number;
  tax_amount: number;
  transaction_count: number;
}

export function usePOSEnhancedReports(options?: { dateFrom?: string; dateTo?: string; registerId?: string; branchId?: string }) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranch();
  const { canOversee } = usePOSOverseer();
  const businessId = currentBusiness?.id;
  const filterFrom = options?.dateFrom;
  const filterTo = options?.dateTo;
  const filterRegister = options?.registerId;
  const filterBranch = options?.branchId ?? currentBranch?.id ?? null;
  // Stage R-Wave-A: org-wide fan-out reports are disabled for non-overseers
  // when no branch context is set, preventing accidental cross-branch totals.
  const enhancedReportsEnabled = !!currentOrg?.id && !!businessId
    && (filterBranch !== null || canOversee);

  const getDateRange = (defaultDays: number) => {
    const from = filterFrom || format(subDays(new Date(), defaultDays), "yyyy-MM-dd");
    const to = filterTo ? filterTo + "T23:59:59" : new Date().toISOString();
    return { from, to };
  };

  // Helper to add register filter
  const applyRegisterFilter = (query: any) => {
    if (filterRegister && filterRegister !== "all") {
      return query.eq("register_id", filterRegister);
    }
    return query;
  };

  const applyBranchFilter = (query: any) => {
    if (filterBranch && filterBranch !== "all") {
      return query.eq("branch_id", filterBranch);
    }
    return query;
  };

  // Cashier Performance Report
  const { data: cashierPerformance = [], isLoading: isCashierLoading } = useQuery({
    queryKey: ["pos-cashier-performance", currentOrg?.id, businessId, filterFrom, filterTo, filterRegister, filterBranch],
    queryFn: async () => {
      if (!currentOrg?.id || !businessId) return [];

      const { from, to } = getDateRange(30);

      let txQuery = supabase
        .from("pos_transactions")
        .select(`id, total, transaction_type, status, created_by, discount_amount, created_at`)
        .eq("organization_id", currentOrg.id)
        .eq("business_id", businessId)
        .gte("created_at", from)
        .lte("created_at", to);

      txQuery = applyBranchFilter(applyRegisterFilter(txQuery));
      const { data: transactions } = await txQuery;

      if (!transactions || transactions.length === 0) return [];

      const cashierIds = [...new Set(transactions.map(t => t.created_by).filter(Boolean))] as string[];
      const { data: profiles } = await supabase
        .from("profiles")
        .select("user_id, email, full_name")
        .in("user_id", cashierIds);

      const profileMap = new Map(profiles?.map(p => [p.user_id, p]) || []);

      let shiftsQuery = supabase
        .from("pos_shifts")
        .select("user_id, cash_difference")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", businessId)
        .not("cash_difference", "is", null)
        .gte("opened_at", from);
      shiftsQuery = applyBranchFilter(shiftsQuery);
      const { data: shifts } = await shiftsQuery;

      const cashierMap = new Map<string, {
        sales: number; sales_count: number; returns: number; returns_count: number;
        voids: number; discounts: number; cash_variance: number;
      }>();

      transactions.forEach(tx => {
        if (!tx.created_by) return;
        if (!cashierMap.has(tx.created_by)) {
          cashierMap.set(tx.created_by, { sales: 0, sales_count: 0, returns: 0, returns_count: 0, voids: 0, discounts: 0, cash_variance: 0 });
        }
        const stats = cashierMap.get(tx.created_by)!;
        if (tx.transaction_type === "sale" && tx.status === "completed") {
          stats.sales += tx.total;
          stats.sales_count += 1;
          stats.discounts += tx.discount_amount || 0;
        } else if (tx.transaction_type === "return") {
          stats.returns += tx.total;
          stats.returns_count += 1;
        } else if (tx.status === "voided") {
          stats.voids += 1;
        }
      });

      shifts?.forEach(shift => {
        if (shift.user_id && cashierMap.has(shift.user_id)) {
          cashierMap.get(shift.user_id)!.cash_variance += shift.cash_difference || 0;
        }
      });

      return Array.from(cashierMap.entries()).map(([userId, stats]): CashierPerformance => {
        const profile: any = profileMap.get(userId);
        return {
          user_id: userId,
          user_email: profile?.full_name || profile?.email || "Unknown",
          total_sales: stats.sales,
          transaction_count: stats.sales_count,
          avg_transaction: stats.sales_count > 0 ? stats.sales / stats.sales_count : 0,
          returns_count: stats.returns_count,
          returns_total: stats.returns,
          void_count: stats.voids,
          discount_given: stats.discounts,
          avg_transaction_time_seconds: 0,
          cash_over_short: stats.cash_variance,
        };
      }).sort((a, b) => b.total_sales - a.total_sales);
    },
    enabled: enhancedReportsEnabled,
  });

  // Fraud Detection Report
  const { data: fraudIndicators = [], isLoading: isFraudLoading } = useQuery({
    queryKey: ["pos-fraud-indicators", currentOrg?.id, businessId, filterFrom, filterTo, filterRegister, filterBranch],
    queryFn: async () => {
      if (!currentOrg?.id || !businessId) return [];

      const { from, to } = getDateRange(7);
      const indicators: FraudIndicator[] = [];

      let txQuery = supabase
        .from("pos_transactions")
        .select("created_by, status, total, created_at")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", businessId)
        .gte("created_at", from)
        .lte("created_at", to);

      txQuery = applyBranchFilter(applyRegisterFilter(txQuery));
      const { data: transactions } = await txQuery;

      if (!transactions) return [];

      const cashierIds = [...new Set(transactions.map(t => t.created_by).filter(Boolean))] as string[];
      const { data: profiles } = await supabase
        .from("profiles")
        .select("user_id, email")
        .in("user_id", cashierIds);

      const profileMap = new Map(profiles?.map(p => [p.user_id, p.email]) || []);

      const voidsByCashier = new Map<string, { count: number; total: number }>();
      const salesByCashier = new Map<string, number>();

      transactions.forEach(tx => {
        if (!tx.created_by) return;
        if (tx.status === "voided") {
          if (!voidsByCashier.has(tx.created_by)) voidsByCashier.set(tx.created_by, { count: 0, total: 0 });
          voidsByCashier.get(tx.created_by)!.count += 1;
          voidsByCashier.get(tx.created_by)!.total += tx.total;
        } else if (tx.status === "completed") {
          salesByCashier.set(tx.created_by, (salesByCashier.get(tx.created_by) || 0) + 1);
        }
      });

      voidsByCashier.forEach((voids, cashierId) => {
        const totalSales = salesByCashier.get(cashierId) || 0;
        const voidRate = totalSales > 0 ? (voids.count / totalSales) * 100 : 0;
        if (voidRate > 5 || voids.count > 10) {
          indicators.push({
            type: "void_pattern",
            severity: voidRate > 10 ? "high" : voidRate > 5 ? "medium" : "low",
            user_id: cashierId,
            user_email: (profileMap.get(cashierId) as string) || "Unknown",
            description: `${voids.count} voids (${voidRate.toFixed(1)}% of transactions)`,
            count: voids.count,
            amount: voids.total,
            timestamp: new Date().toISOString(),
          });
        }
      });

      const { data: shifts } = await supabase
        .from("pos_shifts")
        .select("user_id, cash_difference, closed_at")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", businessId)
        .not("cash_difference", "is", null)
        .gte("opened_at", from);

      const varianceByCashier = new Map<string, number[]>();
      shifts?.forEach(shift => {
        if (!shift.user_id || !shift.cash_difference) return;
        if (!varianceByCashier.has(shift.user_id)) varianceByCashier.set(shift.user_id, []);
        varianceByCashier.get(shift.user_id)!.push(shift.cash_difference);
      });

      varianceByCashier.forEach((variances, cashierId) => {
        const totalVariance = variances.reduce((sum, v) => sum + Math.abs(v), 0);
        const avgVariance = totalVariance / variances.length;
        if (avgVariance > 50 || totalVariance > 200) {
          indicators.push({
            type: "cash_variance",
            severity: avgVariance > 100 ? "high" : avgVariance > 50 ? "medium" : "low",
            user_id: cashierId,
            user_email: (profileMap.get(cashierId) as string) || "Unknown",
            description: `Avg ${avgVariance.toFixed(2)} over/short per shift`,
            count: variances.length,
            amount: totalVariance,
            timestamp: new Date().toISOString(),
          });
        }
      });

      return indicators.sort((a, b) => {
        const severityOrder = { high: 0, medium: 1, low: 2 };
        return severityOrder[a.severity] - severityOrder[b.severity];
      });
    },
    enabled: enhancedReportsEnabled,
  });

  // ABC Analysis
  const { data: abcAnalysis = [], isLoading: isABCLoading } = useQuery({
    queryKey: ["pos-abc-analysis", currentOrg?.id, businessId, filterFrom, filterTo, filterRegister, filterBranch],
    queryFn: async () => {
      if (!currentOrg?.id || !businessId) return [];

      const { from, to } = getDateRange(30);

      let txQuery = supabase
        .from("pos_transactions")
        .select("id")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", businessId)
        .eq("status", "completed")
        .eq("transaction_type", "sale")
        .gte("created_at", from)
        .lte("created_at", to);

      txQuery = applyBranchFilter(applyRegisterFilter(txQuery));
      const { data: transactions } = await txQuery;

      if (!transactions || transactions.length === 0) return [];

      const transactionIds = transactions.map(t => t.id);

      const { data: items } = await supabase
        .from("pos_transaction_items")
        .select("product_id, description, quantity, line_total")
        .in("transaction_id", transactionIds);

      if (!items || items.length === 0) return [];

      const productMap = new Map<string, { name: string; revenue: number; quantity: number }>();
      items.forEach(item => {
        const key = item.product_id || item.description;
        if (!productMap.has(key)) productMap.set(key, { name: item.description, revenue: 0, quantity: 0 });
        const product = productMap.get(key)!;
        product.revenue += item.line_total;
        product.quantity += item.quantity;
      });

      const products = Array.from(productMap.entries())
        .map(([id, data]) => ({ id, ...data }))
        .sort((a, b) => b.revenue - a.revenue);

      const totalRevenue = products.reduce((sum, p) => sum + p.revenue, 0);
      let cumulative = 0;

      return products.map((product): ABCProduct => {
        const percent = (product.revenue / totalRevenue) * 100;
        cumulative += percent;
        let category: "A" | "B" | "C";
        if (cumulative <= 80) category = "A";
        else if (cumulative <= 95) category = "B";
        else category = "C";

        return {
          id: product.id,
          name: product.name,
          category,
          revenue: product.revenue,
          revenue_percent: percent,
          quantity: product.quantity,
          cumulative_percent: cumulative,
        };
      });
    },
    enabled: enhancedReportsEnabled,
  });

  // Customer Analytics
  const { data: customerAnalytics, isLoading: isCustomerLoading } = useQuery({
    queryKey: ["pos-customer-analytics", currentOrg?.id, businessId, filterFrom, filterTo, filterRegister, filterBranch],
    queryFn: async (): Promise<CustomerAnalytics> => {
      if (!currentOrg?.id || !businessId) {
        return { total_customers: 0, new_customers: 0, returning_customers: 0, avg_basket_size: 0, avg_visits_per_customer: 0, top_customers: [] };
      }

      const { from, to } = getDateRange(30);

      let txQuery = supabase
        .from("pos_transactions")
        .select("id, customer_id, customer_name, total, created_at")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", businessId)
        .eq("status", "completed")
        .eq("transaction_type", "sale")
        .not("customer_id", "is", null)
        .gte("created_at", from)
        .lte("created_at", to);

      txQuery = applyBranchFilter(applyRegisterFilter(txQuery));
      const { data: transactions } = await txQuery;

      if (!transactions || transactions.length === 0) {
        return { total_customers: 0, new_customers: 0, returning_customers: 0, avg_basket_size: 0, avg_visits_per_customer: 0, top_customers: [] };
      }

      const customerStats = new Map<string, { name: string; total: number; visits: number }>();
      transactions.forEach(tx => {
        if (!tx.customer_id) return;
        if (!customerStats.has(tx.customer_id)) {
          customerStats.set(tx.customer_id, { name: tx.customer_name || "Unknown", total: 0, visits: 0 });
        }
        customerStats.get(tx.customer_id)!.total += tx.total;
        customerStats.get(tx.customer_id)!.visits += 1;
      });

      const totalCustomers = customerStats.size;
      const totalSales = transactions.reduce((sum, t) => sum + t.total, 0);
      const totalVisits = transactions.length;

      const topCustomers = Array.from(customerStats.entries())
        .map(([customerId, stats]) => ({
          contact_id: customerId, name: stats.name, total_spent: stats.total,
          visit_count: stats.visits, avg_basket: stats.visits > 0 ? stats.total / stats.visits : 0,
        }))
        .sort((a, b) => b.total_spent - a.total_spent)
        .slice(0, 10);

      const newCustomers = [...customerStats.values()].filter(c => c.visits === 1).length;

      return {
        total_customers: totalCustomers,
        new_customers: newCustomers,
        returning_customers: totalCustomers - newCustomers,
        avg_basket_size: totalVisits > 0 ? totalSales / totalVisits : 0,
        avg_visits_per_customer: totalCustomers > 0 ? totalVisits / totalCustomers : 0,
        top_customers: topCustomers,
      };
    },
    enabled: enhancedReportsEnabled,
  });

  // Payment Method Breakdown
  const { data: paymentBreakdown = [], isLoading: isPaymentLoading } = useQuery({
    queryKey: ["pos-payment-breakdown", currentOrg?.id, businessId, filterFrom, filterTo, filterRegister, filterBranch],
    queryFn: async (): Promise<PaymentMethodBreakdown[]> => {
      if (!currentOrg?.id || !businessId) return [];

      const { from, to } = getDateRange(30);

      let txQuery = supabase
        .from("pos_transactions")
        .select("id")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", businessId)
        .eq("status", "completed")
        .eq("transaction_type", "sale")
        .gte("created_at", from)
        .lte("created_at", to);

      txQuery = applyBranchFilter(applyRegisterFilter(txQuery));
      const { data: transactions } = await txQuery;

      if (!transactions || transactions.length === 0) return [];

      const transactionIds = transactions.map(t => t.id);
      const { data: payments } = await supabase
        .from("pos_transaction_payments")
        .select("payment_method, amount")
        .in("transaction_id", transactionIds);

      if (!payments || payments.length === 0) return [];

      const methodMap = new Map<string, { total: number; count: number }>();
      payments.forEach(p => {
        if (!methodMap.has(p.payment_method)) methodMap.set(p.payment_method, { total: 0, count: 0 });
        methodMap.get(p.payment_method)!.total += p.amount;
        methodMap.get(p.payment_method)!.count += 1;
      });

      const grandTotal = [...methodMap.values()].reduce((s, v) => s + v.total, 0);

      return Array.from(methodMap.entries())
        .map(([method, data]) => ({
          payment_method: method,
          total_amount: data.total,
          transaction_count: data.count,
          percentage: grandTotal > 0 ? (data.total / grandTotal) * 100 : 0,
        }))
        .sort((a, b) => b.total_amount - a.total_amount);
    },
    enabled: enhancedReportsEnabled,
  });

  // Tax Summary
  const { data: taxSummary = [], isLoading: isTaxLoading } = useQuery({
    queryKey: ["pos-tax-summary", currentOrg?.id, businessId, filterFrom, filterTo, filterRegister, filterBranch],
    queryFn: async (): Promise<TaxSummaryItem[]> => {
      if (!currentOrg?.id || !businessId) return [];

      const { from, to } = getDateRange(30);

      let txQuery = supabase
        .from("pos_transactions")
        .select("id")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", businessId)
        .eq("status", "completed")
        .eq("transaction_type", "sale")
        .gte("created_at", from)
        .lte("created_at", to);

      txQuery = applyBranchFilter(applyRegisterFilter(txQuery));
      const { data: transactions } = await txQuery;

      if (!transactions || transactions.length === 0) return [];

      const transactionIds = transactions.map(t => t.id);
      const { data: items } = await supabase
        .from("pos_transaction_items")
        .select("tax_rate, tax_amount, line_total")
        .in("transaction_id", transactionIds);

      if (!items || items.length === 0) return [];

      const taxMap = new Map<number, { taxable: number; tax: number; count: number }>();
      items.forEach(item => {
        const rate = item.tax_rate || 0;
        if (!taxMap.has(rate)) taxMap.set(rate, { taxable: 0, tax: 0, count: 0 });
        const entry = taxMap.get(rate)!;
        entry.taxable += item.line_total;
        entry.tax += item.tax_amount || 0;
        entry.count += 1;
      });

      return Array.from(taxMap.entries())
        .map(([rate, data]) => ({
          tax_rate: rate,
          taxable_amount: data.taxable,
          tax_amount: data.tax,
          transaction_count: data.count,
        }))
        .sort((a, b) => b.tax_rate - a.tax_rate);
    },
    enabled: enhancedReportsEnabled,
  });

  return {
    cashierPerformance,
    isCashierLoading,
    fraudIndicators,
    isFraudLoading,
    abcAnalysis,
    isABCLoading,
    customerAnalytics,
    isCustomerLoading,
    paymentBreakdown,
    isPaymentLoading,
    taxSummary,
    isTaxLoading,
  };
}
