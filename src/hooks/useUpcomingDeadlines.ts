/**
 * useUpcomingDeadlines — aggregates dated obligations that fall in the
 * next 14 days so the dashboard can surface a forward-looking "what's
 * coming up" panel. Closes the previously-missing "what will happen
 * next" gap from the dashboard audit prompt.
 *
 * Each item is module-gated upstream by useDashboardComposition; this
 * hook itself just issues cheap queries scoped to the current org +
 * business. Hidden entirely when no items resolve.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";

export interface UpcomingDeadlineItem {
  id: string;
  kind: "invoice" | "bill" | "payroll";
  label: string;
  dueDate: string; // ISO date
  amount?: number;
  href: string;
}

export interface UseUpcomingDeadlinesOpts {
  hasSales: boolean;
  hasPurchases: boolean;
  hasHR: boolean;
}

const WINDOW_DAYS = 14;

export function useUpcomingDeadlines(opts: UseUpcomingDeadlinesOpts) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const orgId = currentOrg?.id ?? null;
  const businessId = currentBusiness?.id ?? null;
  const enabled = !!orgId && !!businessId && (opts.hasSales || opts.hasPurchases || opts.hasHR);

  return useQuery({
    queryKey: ["upcoming-deadlines", orgId, businessId, opts],
    enabled,
    staleTime: 60_000,
    queryFn: async (): Promise<UpcomingDeadlineItem[]> => {
      if (!orgId || !businessId) return [];
      const today = new Date().toISOString().slice(0, 10);
      const until = new Date(Date.now() + WINDOW_DAYS * 86_400_000)
        .toISOString()
        .slice(0, 10);
      const items: UpcomingDeadlineItem[] = [];

      if (opts.hasSales) {
        const { data } = await supabase
          .from("invoices")
          .select("id, invoice_number, due_date, total, status")
          .eq("organization_id", orgId)
          .eq("business_id", businessId)
          .in("status", ["sent", "partial", "viewed"])
          .gte("due_date", today)
          .lte("due_date", until)
          .order("due_date", { ascending: true })
          .limit(5);
        for (const r of data ?? []) {
          items.push({
            id: `inv-${r.id}`,
            kind: "invoice",
            label: `Invoice ${r.invoice_number}`,
            dueDate: r.due_date as string,
            amount: Number((r as any).total ?? 0),
            href: `/sales/invoices`,
          });
        }
      }

      if (opts.hasPurchases) {
        const { data } = await supabase
          .from("bills")
          .select("id, bill_number, due_date, total, status")
          .eq("organization_id", orgId)
          .eq("business_id", businessId)
          .in("status", ["open", "partial"])
          .gte("due_date", today)
          .lte("due_date", until)
          .order("due_date", { ascending: true })
          .limit(5);
        for (const r of data ?? []) {
          items.push({
            id: `bill-${r.id}`,
            kind: "bill",
            label: `Bill ${(r as any).bill_number ?? ""}`.trim(),
            dueDate: r.due_date as string,
            amount: Number((r as any).total ?? 0),
            href: `/purchases/bills`,
          });
        }
      }

      if (opts.hasHR) {
        const { data } = await (supabase as any)
          .from("payroll_runs")
          .select("id, payroll_number, pay_period_end, payment_date, status, total_net")
          .eq("organization_id", orgId)
          .eq("business_id", businessId)
          .in("status", ["draft", "computed", "approved"])
          .lte("pay_period_end", until)
          .order("pay_period_end", { ascending: true })
          .limit(3);
        for (const r of (data ?? []) as any[]) {
          items.push({
            id: `run-${r.id}`,
            kind: "payroll",
            label: `Payroll ${r.payroll_number ?? ""}`.trim(),
            dueDate: (r.payment_date ?? r.pay_period_end) as string,
            amount: Number(r.total_net ?? 0),
            href: `/hr/payroll`,
          });
        }
      }

      return items.sort((a, b) => a.dueDate.localeCompare(b.dueDate)).slice(0, 8);
    },
  });
}