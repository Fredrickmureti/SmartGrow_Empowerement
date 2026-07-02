/**
 * Report Filter Context
 * 
 * Provides shared filter state (date range, comparison mode, business filter)
 * across all report pages. Ensures consistent filtering and enables
 * saved view filter restoration.
 */

import { createContext, useContext, useState, useCallback, ReactNode } from "react";
import { format, startOfYear, endOfMonth, startOfMonth, endOfYear, subMonths, subYears, startOfQuarter, endOfQuarter } from "date-fns";

export type DatePreset = "this_month" | "last_month" | "this_quarter" | "last_quarter" | "this_year" | "last_year" | "custom";
export type ComparisonMode = "none" | "previous_period" | "same_period_last_year";

export interface ReportFilterState {
  dateFrom: string;
  dateTo: string;
  datePreset: DatePreset;
  comparisonMode: ComparisonMode;
  /**
   * Optional branch dimension filter for per-branch reporting.
   * `null` = "All branches" (company-wide). A specific id narrows P&L,
   * Trial Balance, GL, AR/AP aging, Sales Reports to one branch.
   */
  branchId: string | null;
}

interface ReportFilterContextValue {
  filters: ReportFilterState;
  setDateFrom: (date: string) => void;
  setDateTo: (date: string) => void;
  setDatePreset: (preset: DatePreset) => void;
  setComparisonMode: (mode: ComparisonMode) => void;
  setBranchId: (id: string | null) => void;
  applyPreset: (preset: DatePreset) => void;
  restoreFilters: (filters: Partial<ReportFilterState>) => void;
}

const now = new Date();
const defaultFilters: ReportFilterState = {
  dateFrom: format(startOfYear(now), "yyyy-MM-dd"),
  dateTo: format(endOfMonth(now), "yyyy-MM-dd"),
  datePreset: "this_year",
  comparisonMode: "none",
  branchId: null,
};

const ReportFilterContext = createContext<ReportFilterContextValue | null>(null);

export function getPresetDates(preset: DatePreset): { from: string; to: string } {
  const now = new Date();
  switch (preset) {
    case "this_month":
      return { from: format(startOfMonth(now), "yyyy-MM-dd"), to: format(endOfMonth(now), "yyyy-MM-dd") };
    case "last_month": {
      const d = subMonths(now, 1);
      return { from: format(startOfMonth(d), "yyyy-MM-dd"), to: format(endOfMonth(d), "yyyy-MM-dd") };
    }
    case "this_quarter":
      return { from: format(startOfQuarter(now), "yyyy-MM-dd"), to: format(endOfQuarter(now), "yyyy-MM-dd") };
    case "last_quarter": {
      const d = subMonths(now, 3);
      return { from: format(startOfQuarter(d), "yyyy-MM-dd"), to: format(endOfQuarter(d), "yyyy-MM-dd") };
    }
    case "this_year":
      return { from: format(startOfYear(now), "yyyy-MM-dd"), to: format(endOfYear(now), "yyyy-MM-dd") };
    case "last_year": {
      const d = subYears(now, 1);
      return { from: format(startOfYear(d), "yyyy-MM-dd"), to: format(endOfYear(d), "yyyy-MM-dd") };
    }
    default:
      return { from: format(startOfMonth(now), "yyyy-MM-dd"), to: format(endOfMonth(now), "yyyy-MM-dd") };
  }
}

/**
 * Read date_from / date_to / as_of from the current URL and produce seed
 * filters. Lets deep links (e.g. from FiscalPeriodDetail → "General Ledger")
 * pre-select the period without the user re-picking dates.
 */
function readFiltersFromUrl(): ReportFilterState {
  if (typeof window === "undefined") return defaultFilters;
  const sp = new URLSearchParams(window.location.search);
  const from = sp.get("date_from") || sp.get("dateFrom");
  const to = sp.get("date_to") || sp.get("dateTo");
  const asOf = sp.get("as_of") || sp.get("asOf");
  const dateFrom = from || (asOf ? "1970-01-01" : defaultFilters.dateFrom);
  const dateTo = to || asOf || defaultFilters.dateTo;
  const datePreset: DatePreset = from || to || asOf ? "custom" : defaultFilters.datePreset;
  return { ...defaultFilters, dateFrom, dateTo, datePreset };
}

export function ReportFilterProvider({ children }: { children: ReactNode }) {
  const [filters, setFilters] = useState<ReportFilterState>(readFiltersFromUrl);

  const setDateFrom = useCallback((date: string) => {
    setFilters(prev => ({ ...prev, dateFrom: date, datePreset: "custom" }));
  }, []);

  const setDateTo = useCallback((date: string) => {
    setFilters(prev => ({ ...prev, dateTo: date, datePreset: "custom" }));
  }, []);

  const setDatePreset = useCallback((preset: DatePreset) => {
    setFilters(prev => ({ ...prev, datePreset: preset }));
  }, []);

  const setComparisonMode = useCallback((mode: ComparisonMode) => {
    setFilters(prev => ({ ...prev, comparisonMode: mode }));
  }, []);

  const setBranchId = useCallback((id: string | null) => {
    setFilters(prev => ({ ...prev, branchId: id }));
  }, []);

  const applyPreset = useCallback((preset: DatePreset) => {
    if (preset === "custom") {
      setFilters(prev => ({ ...prev, datePreset: "custom" }));
      return;
    }
    const dates = getPresetDates(preset);
    setFilters(prev => ({ ...prev, dateFrom: dates.from, dateTo: dates.to, datePreset: preset }));
  }, []);

  const restoreFilters = useCallback((saved: Partial<ReportFilterState>) => {
    setFilters(prev => ({ ...prev, ...saved }));
  }, []);

  return (
    <ReportFilterContext.Provider value={{
      filters,
      setDateFrom,
      setDateTo,
      setDatePreset,
      setComparisonMode,
      setBranchId,
      applyPreset,
      restoreFilters,
    }}>
      {children}
    </ReportFilterContext.Provider>
  );
}

export function useReportFilters() {
  const ctx = useContext(ReportFilterContext);
  if (!ctx) {
    // Wave 5 hardening: in development, throw loudly so the missing
    // <ReportFilterProvider> wrapper is caught immediately. In prod we keep
    // a defensive no-op fallback so a user is never crashed by a regression,
    // but we also console.error so the issue surfaces in monitoring.
    if (import.meta.env.DEV) {
      throw new Error(
        "useReportFilters() called outside <ReportFilterProvider>. " +
          "Wrap the report page's default export with <ReportFilterProvider>. " +
          "Without it, branch / date filters silently no-op and the toggle does nothing."
      );
    }
    // eslint-disable-next-line no-console
    console.error(
      "[useReportFilters] Called outside <ReportFilterProvider>. Filters will not work. " +
        "This is a bug — wrap the report's default export with <ReportFilterProvider>."
    );
    return {
      filters: defaultFilters,
      setDateFrom: () => {},
      setDateTo: () => {},
      setDatePreset: () => {},
      setComparisonMode: () => {},
      setBranchId: () => {},
      applyPreset: () => {},
      restoreFilters: () => {},
    } as ReportFilterContextValue;
  }
  return ctx;
}
