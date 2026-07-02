/**
 * Report Filters Component
 * 
 * Standard filter bar for financial reports with date range,
 * account selection, and preset quick filters.
 */

import { forwardRef } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Calendar } from "lucide-react";
import {
  format,
  startOfMonth,
  endOfMonth,
  startOfQuarter,
  endOfQuarter,
  startOfYear,
  endOfYear,
  subMonths,
  subYears,
} from "date-fns";

export type DatePreset =
  | "this_month"
  | "last_month"
  | "this_quarter"
  | "last_quarter"
  | "this_year"
  | "last_year"
  | "custom";

export interface ReportFiltersProps {
  /** Date range mode: "range" for from/to, "asof" for single date */
  dateMode?: "range" | "asof";
  dateFrom?: string;
  dateTo: string;
  onDateFromChange?: (date: string) => void;
  onDateToChange: (date: string) => void;
  /** Show include zero balances toggle */
  showZeroToggle?: boolean;
  includeZeroBalances?: boolean;
  onZeroBalancesChange?: (value: boolean) => void;
  /** Show account type filter */
  showAccountTypeFilter?: boolean;
  accountType?: string;
  onAccountTypeChange?: (value: string) => void;
  /** Extra content to render in the filter bar */
  children?: React.ReactNode;
}

const datePresets: { value: DatePreset; label: string }[] = [
  { value: "this_month", label: "This Month" },
  { value: "last_month", label: "Last Month" },
  { value: "this_quarter", label: "This Quarter" },
  { value: "last_quarter", label: "Last Quarter" },
  { value: "this_year", label: "This Year" },
  { value: "last_year", label: "Last Year" },
  { value: "custom", label: "Custom Range" },
];

function getPresetDates(preset: DatePreset): { from: string; to: string } {
  const now = new Date();
  switch (preset) {
    case "this_month":
      return { from: format(startOfMonth(now), "yyyy-MM-dd"), to: format(endOfMonth(now), "yyyy-MM-dd") };
    case "last_month": {
      const last = subMonths(now, 1);
      return { from: format(startOfMonth(last), "yyyy-MM-dd"), to: format(endOfMonth(last), "yyyy-MM-dd") };
    }
    case "this_quarter":
      return { from: format(startOfQuarter(now), "yyyy-MM-dd"), to: format(endOfQuarter(now), "yyyy-MM-dd") };
    case "last_quarter": {
      const lq = subMonths(now, 3);
      return { from: format(startOfQuarter(lq), "yyyy-MM-dd"), to: format(endOfQuarter(lq), "yyyy-MM-dd") };
    }
    case "this_year":
      return { from: format(startOfYear(now), "yyyy-MM-dd"), to: format(endOfYear(now), "yyyy-MM-dd") };
    case "last_year": {
      const ly = subYears(now, 1);
      return { from: format(startOfYear(ly), "yyyy-MM-dd"), to: format(endOfYear(ly), "yyyy-MM-dd") };
    }
    default:
      return { from: format(startOfMonth(now), "yyyy-MM-dd"), to: format(endOfMonth(now), "yyyy-MM-dd") };
  }
}

export const ReportFilters = forwardRef<HTMLDivElement, ReportFiltersProps>(function ReportFilters({
  dateMode = "range",
  dateFrom,
  dateTo,
  onDateFromChange,
  onDateToChange,
  showZeroToggle = false,
  includeZeroBalances = false,
  onZeroBalancesChange,
  showAccountTypeFilter = false,
  accountType,
  onAccountTypeChange,
  children,
}: ReportFiltersProps, ref) {
  const handlePresetChange = (preset: DatePreset) => {
    if (preset === "custom") return;
    const dates = getPresetDates(preset);
    onDateFromChange?.(dates.from);
    onDateToChange(dates.to);
  };

  return (
    <div ref={ref} className="flex flex-col sm:flex-row gap-2 sm:gap-4 items-start sm:items-end flex-wrap">
      {/* Date Preset */}
      <div className="space-y-1 sm:space-y-2 w-full sm:w-auto">
        <Label className="text-xs sm:text-sm">Period</Label>
        <Select onValueChange={(v) => handlePresetChange(v as DatePreset)}>
          <SelectTrigger className="w-full sm:w-[160px] h-8 sm:h-10 text-xs sm:text-sm">
            <SelectValue placeholder="Select period" />
          </SelectTrigger>
          <SelectContent>
            {datePresets.map((p) => (
              <SelectItem key={p.value} value={p.value}>
                {p.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {dateMode === "range" ? (
        <div className="flex gap-2 sm:gap-4 w-full sm:w-auto">
          <div className="space-y-1 sm:space-y-2 flex-1 sm:flex-none">
            <Label htmlFor="dateFrom" className="text-xs sm:text-sm">From</Label>
            <div className="relative">
              <Calendar className="absolute left-2 sm:left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 sm:h-4 sm:w-4 text-muted-foreground" />
              <Input
                id="dateFrom"
                type="date"
                value={dateFrom || ""}
                onChange={(e) => onDateFromChange?.(e.target.value)}
                className="pl-8 sm:pl-10 w-full sm:w-[160px] h-8 sm:h-10 text-xs sm:text-sm"
              />
            </div>
          </div>
          <div className="space-y-1 sm:space-y-2 flex-1 sm:flex-none">
            <Label htmlFor="dateTo" className="text-xs sm:text-sm">To</Label>
            <div className="relative">
              <Calendar className="absolute left-2 sm:left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 sm:h-4 sm:w-4 text-muted-foreground" />
              <Input
                id="dateTo"
                type="date"
                value={dateTo}
                onChange={(e) => onDateToChange(e.target.value)}
                className="pl-8 sm:pl-10 w-full sm:w-[160px] h-8 sm:h-10 text-xs sm:text-sm"
              />
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-1 sm:space-y-2 w-full sm:w-auto">
          <Label htmlFor="asOfDate" className="text-xs sm:text-sm">As of Date</Label>
          <div className="relative">
            <Calendar className="absolute left-2 sm:left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 sm:h-4 sm:w-4 text-muted-foreground" />
            <Input
              id="asOfDate"
              type="date"
              value={dateTo}
              onChange={(e) => {
                onDateToChange(e.target.value);
                onDateFromChange?.(e.target.value);
              }}
              className="pl-8 sm:pl-10 w-full sm:w-[160px] h-8 sm:h-10 text-xs sm:text-sm"
            />
          </div>
        </div>
      )}

      {showAccountTypeFilter && onAccountTypeChange && (
        <div className="space-y-1 sm:space-y-2 w-full sm:w-auto">
          <Label className="text-xs sm:text-sm">Account Type</Label>
          <Select value={accountType || "all"} onValueChange={onAccountTypeChange}>
            <SelectTrigger className="w-full sm:w-[160px] h-8 sm:h-10 text-xs sm:text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Types</SelectItem>
              <SelectItem value="asset">Assets</SelectItem>
              <SelectItem value="liability">Liabilities</SelectItem>
              <SelectItem value="equity">Equity</SelectItem>
              <SelectItem value="income">Income</SelectItem>
              <SelectItem value="expense">Expenses</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}

      {showZeroToggle && onZeroBalancesChange && (
        <div className="flex items-center gap-2 pb-0.5">
          <Switch
            id="includeZero"
            checked={includeZeroBalances}
            onCheckedChange={onZeroBalancesChange}
          />
          <Label htmlFor="includeZero" className="text-xs sm:text-sm">
            Include zero balances
          </Label>
        </div>
      )}

      {children}
    </div>
  );
});
