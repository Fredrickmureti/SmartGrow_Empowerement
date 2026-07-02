import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Loader2, CalendarPlus, AlertCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { usePayrollPeriods, PayrollPeriod } from "@/hooks/usePayrollPeriods";
import { format, startOfMonth, endOfMonth, subMonths, addMonths } from "date-fns";

interface PayrollPeriodSelectorProps {
  value: { pay_period_start: string; pay_period_end: string; payment_date: string };
  onChange: (data: { pay_period_start: string; pay_period_end: string; payment_date: string }) => void;
}

/** Generate month presets: last 3 months + current month + next month */
function getMonthPresets(): { label: string; start: string; end: string }[] {
  const presets: { label: string; start: string; end: string }[] = [];
  for (let i = 3; i >= -1; i--) {
    const m = i >= 0 ? subMonths(new Date(), i) : addMonths(new Date(), Math.abs(i));
    presets.push({
      label: format(m, "MMMM yyyy"),
      start: format(startOfMonth(m), "yyyy-MM-dd"),
      end: format(endOfMonth(m), "yyyy-MM-dd"),
    });
  }
  return presets;
}

export function PayrollPeriodSelector({ value, onChange }: PayrollPeriodSelectorProps) {
  const { openPeriods, isLoading: isLoadingPeriods, generatePeriods } = usePayrollPeriods();
  const [isGenerating, setIsGenerating] = useState(false);

  const hasDbPeriods = openPeriods.length > 0;

  const handleGeneratePeriods = async () => {
    setIsGenerating(true);
    try {
      await generatePeriods.mutateAsync({ year: new Date().getFullYear(), periodType: "monthly" });
    } finally {
      setIsGenerating(false);
    }
  };

  // Resolve which Select option (if any) matches the current form values.
  // For DB-managed periods the option value embeds payment_date, so we must
  // match on (start, end) and rebuild the full token. When nothing matches
  // we surface a "Custom dates" sentinel so the trigger reflects reality
  // instead of looking empty after the user types into the date inputs.
  const monthPresets = getMonthPresets();
  const matchedDbPeriod = hasDbPeriods
    ? openPeriods.find(
        (p) => p.start_date === value.pay_period_start && p.end_date === value.pay_period_end,
      )
    : undefined;
  const matchedPreset = !hasDbPeriods
    ? monthPresets.find(
        (p) => p.start === value.pay_period_start && p.end === value.pay_period_end,
      )
    : undefined;
  const currentSelectValue: string = matchedDbPeriod
    ? `${matchedDbPeriod.start_date}|${matchedDbPeriod.end_date}|${matchedDbPeriod.payment_date || ""}`
    : matchedPreset
      ? `${matchedPreset.start}|${matchedPreset.end}`
      : "__custom__";

  const customLabel =
    value.pay_period_start && value.pay_period_end
      ? `Custom: ${format(new Date(value.pay_period_start), "MMM d")} – ${format(new Date(value.pay_period_end), "MMM d, yyyy")}`
      : "Custom dates";

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label>Pay Period</Label>
        {hasDbPeriods && (
          <Badge variant="outline" className="text-[10px]">Managed Periods</Badge>
        )}
      </div>

      {hasDbPeriods ? (
        <Select
          value={currentSelectValue}
          onValueChange={(val) => {
            if (val === "__custom__") return; // already in custom mode; no-op
            const [start, end, paymentDate] = val.split("|");
            onChange({
              pay_period_start: start,
              pay_period_end: end,
              payment_date: paymentDate || value.payment_date,
            });
          }}
        >
          <SelectTrigger>
            <SelectValue placeholder="Select pay period..." />
          </SelectTrigger>
          <SelectContent>
            {openPeriods.map((p) => (
              <SelectItem
                key={p.id}
                value={`${p.start_date}|${p.end_date}|${p.payment_date || ""}`}
              >
                <div className="flex items-center gap-2">
                  <span>{p.name}</span>
                  {p.payroll_run_id && (
                    <Badge variant="secondary" className="text-[10px]">Has Run</Badge>
                  )}
                </div>
              </SelectItem>
            ))}
            <SelectItem value="__custom__">{customLabel}</SelectItem>
          </SelectContent>
        </Select>
      ) : (
        <Select
          value={currentSelectValue}
          onValueChange={(val) => {
            if (val === "__custom__") return;
            const [start, end] = val.split("|");
            onChange({ ...value, pay_period_start: start, pay_period_end: end });
          }}
        >
          <SelectTrigger>
            <SelectValue placeholder="Select month..." />
          </SelectTrigger>
          <SelectContent>
            {monthPresets.map((p) => (
              <SelectItem key={p.start} value={`${p.start}|${p.end}`}>
                {p.label}
              </SelectItem>
            ))}
            <SelectItem value="__custom__">{customLabel}</SelectItem>
          </SelectContent>
        </Select>
      )}

      {!hasDbPeriods && !isLoadingPeriods && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <AlertCircle className="h-3 w-3 shrink-0" />
          <span>No payroll periods configured.</span>
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto p-0 text-xs"
            disabled={isGenerating}
            onClick={handleGeneratePeriods}
          >
            {isGenerating ? (
              <Loader2 className="h-3 w-3 mr-1 animate-spin" />
            ) : (
              <CalendarPlus className="h-3 w-3 mr-1" />
            )}
            Generate {new Date().getFullYear()} periods
          </Button>
        </div>
      )}
    </div>
  );
}
