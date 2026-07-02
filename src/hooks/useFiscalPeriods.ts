import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { toast } from "sonner";
import { format, startOfMonth, endOfMonth, startOfQuarter, endOfQuarter } from "date-fns";
import { normalizeError } from "@/services/resilience";

export interface FiscalPeriod {
  id: string;
  organization_id: string;
  business_id: string | null;
  name: string;
  period_type: "month" | "quarter" | "year";
  start_date: string;
  end_date: string;
  status: "open" | "closing" | "closed";
  locked_at: string | null;
  locked_by: string | null;
  closing_entry_id: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Returns the fiscal year start month (1-12) for the company (Odoo: res.company).
 * Identity moved off `organizations` per Phase-7 architecture — fiscal_year_start
 * now lives on `businesses`.
 * Falls back to 1 (January) if not set.
 */
async function fetchFiscalYearStart(orgId: string, businessId?: string | null): Promise<number> {
  const query = supabase
    .from("businesses")
    .select("fiscal_year_start")
    .eq("organization_id", orgId)
    .eq("is_active", true);

  const { data, error } = businessId
    ? await query.eq("id", businessId).maybeSingle()
    : await query.order("created_at", { ascending: true }).limit(1).maybeSingle();

  if (error || !data?.fiscal_year_start) return 1; // default January
  return data.fiscal_year_start;
}

/**
 * Computes fiscal year start/end dates given a fiscal "label year" and start month.
 * E.g. fiscal_year_start=7, year=2025 → July 1 2025 – June 30 2026
 * fiscal_year_start=1, year=2025 → Jan 1 2025 – Dec 31 2025
 */
function getFiscalYearBounds(year: number, fiscalStartMonth: number) {
  const startDate = new Date(year, fiscalStartMonth - 1, 1);
  // End is last day of the month before the start month in the next cycle
  const endDate = new Date(year + (fiscalStartMonth === 1 ? 0 : 1), fiscalStartMonth === 1 ? 11 : fiscalStartMonth - 2 + 1, 0);
  return { startDate, endDate };
}

export function useFiscalPeriods() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const queryClient = useQueryClient();

  const { data: periods = [], isLoading } = useQuery({
    queryKey: ["fiscal-periods", currentOrg?.id, currentBusiness?.id],
    queryFn: async () => {
      if (!currentOrg?.id) return [];

      let query = supabase
        .from("fiscal_periods")
        .select("*")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .order("start_date", { ascending: false });

      if (currentBusiness?.id) {
        query = query.or(`business_id.eq.${currentBusiness.id},business_id.is.null`);
      }

      const { data, error } = await query;
      if (error) throw error;
      return data as FiscalPeriod[];
    },
    enabled: !!currentOrg?.id,
  });

  // Generate periods for a fiscal year, respecting fiscal_year_start
  const generatePeriods = useMutation({
    mutationFn: async ({ year, periodType }: { year: number; periodType: "month" | "quarter" }) => {
      if (!currentOrg?.id) throw new Error("No organization selected");

      const fiscalStartMonth = await fetchFiscalYearStart(currentOrg.id, currentBusiness?.id);
      const { startDate: fyStart, endDate: fyEnd } = getFiscalYearBounds(year, fiscalStartMonth);

      const periodsToCreate: Omit<FiscalPeriod, "id" | "created_at" | "updated_at" | "locked_at" | "locked_by" | "closing_entry_id">[] = [];

      if (periodType === "month") {
        for (let i = 0; i < 12; i++) {
          const monthDate = new Date(fyStart.getFullYear(), fyStart.getMonth() + i, 1);
          periodsToCreate.push({
            organization_id: currentOrg.id,
            business_id: currentBusiness?.id || null,
            name: format(monthDate, "MMMM yyyy"),
            period_type: "month",
            start_date: format(startOfMonth(monthDate), "yyyy-MM-dd"),
            end_date: format(endOfMonth(monthDate), "yyyy-MM-dd"),
            status: "open",
            notes: null,
          });
        }
      } else {
        // Quarterly: generate 4 quarters starting from fiscal year start
        for (let q = 0; q < 4; q++) {
          const qStartDate = new Date(fyStart.getFullYear(), fyStart.getMonth() + q * 3, 1);
          const qEndDate = new Date(fyStart.getFullYear(), fyStart.getMonth() + q * 3 + 3, 0); // last day of 3rd month
          periodsToCreate.push({
            organization_id: currentOrg.id,
            business_id: currentBusiness?.id || null,
            name: `Q${q + 1} FY${year}`,
            period_type: "quarter",
            start_date: format(qStartDate, "yyyy-MM-dd"),
            end_date: format(qEndDate, "yyyy-MM-dd"),
            status: "open",
            notes: null,
          });
        }
      }

      // Also create yearly period
      periodsToCreate.push({
        organization_id: currentOrg.id,
        business_id: currentBusiness?.id || null,
        name: `FY ${year}`,
        period_type: "year",
        start_date: format(fyStart, "yyyy-MM-dd"),
        end_date: format(fyEnd, "yyyy-MM-dd"),
        status: "open",
        notes: null,
      });

      const { error } = await supabase
        .from("fiscal_periods")
        .upsert(periodsToCreate, { 
          onConflict: "organization_id,business_id,start_date,end_date",
          ignoreDuplicates: true 
        });

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["fiscal-periods"] });
      queryClient.invalidateQueries({ queryKey: ["fiscal-periods-check"] });
      toast.success("Fiscal periods generated successfully");
    },
    onError: (error) => {
      toast.error(`Failed to generate periods: ${normalizeError(error).message}`);
    },
  });

  // Close a period — Wave 5: routed through SECURITY DEFINER RPC that
  // enforces finance.manage_periods permission server-side. Direct UPDATE
  // is also blocked by trg_fiscal_periods_no_branch_context for branch
  // sessions (UI gate is purely UX).
  const closePeriod = useMutation({
    mutationFn: async ({ periodId, notes }: { periodId: string; notes?: string }) => {
      const { error } = await (supabase as any).rpc("close_fiscal_period", {
        _period_id: periodId,
        _notes: notes ?? null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["fiscal-periods"] });
      queryClient.invalidateQueries({ queryKey: ["fiscal-periods-check"] });
      toast.success("Period closed and locked");
    },
    onError: (error) => {
      toast.error(`Failed to close period: ${normalizeError(error).message}`);
    },
  });

  // Reopen a period (admin only) — Wave 5: routed through SECURITY DEFINER
  // RPC; same permission gate as close.
  const reopenPeriod = useMutation({
    mutationFn: async (periodId: string) => {
      const { error } = await (supabase as any).rpc("reopen_fiscal_period", {
        _period_id: periodId,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["fiscal-periods"] });
      queryClient.invalidateQueries({ queryKey: ["fiscal-periods-check"] });
      toast.success("Period reopened");
    },
    onError: (error) => {
      toast.error(`Failed to reopen period: ${normalizeError(error).message}`);
    },
  });

  // Check if a date is in a closed period
  const isDateLocked = (date: string): boolean => {
    const checkDate = new Date(date);
    return periods.some(
      (p) =>
        p.status === "closed" &&
        new Date(p.start_date) <= checkDate &&
        new Date(p.end_date) >= checkDate
    );
  };

  // Get the current open period
  const getCurrentPeriod = (): FiscalPeriod | undefined => {
    const today = new Date();
    return periods.find(
      (p) =>
        p.status === "open" &&
        p.period_type === "month" &&
        new Date(p.start_date) <= today &&
        new Date(p.end_date) >= today
    );
  };

  return {
    periods,
    isLoading,
    generatePeriods,
    closePeriod,
    reopenPeriod,
    isDateLocked,
    getCurrentPeriod,
    // Expose helper for year-end closing to use
    getFiscalYearBounds: async (year: number) => {
      if (!currentOrg?.id) return { startDate: new Date(year, 0, 1), endDate: new Date(year, 11, 31) };
      const fiscalStartMonth = await fetchFiscalYearStart(currentOrg.id, currentBusiness?.id);
      return getFiscalYearBounds(year, fiscalStartMonth);
    },
  };
}
