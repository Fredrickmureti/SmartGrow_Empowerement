import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import {
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle,
} from "@/components/ui/sheet";
import { Loader2, Eye, Users, ChevronDown, AlertTriangle } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Badge } from "@/components/ui/badge";
import { useMemo, useState } from "react";
import { useCurrency } from "@/hooks/useCurrency";
import { VariableEarningsInput } from "@/components/payroll/VariableEarningsInput";
import { VariableEarningsInput as VEInput } from "@/hooks/usePayroll";
import { PayrollPeriodSelector } from "@/components/payroll/PayrollPeriodSelector";
import { PreRunReadinessSummary } from "@/components/payroll/PreRunReadinessSummary";
import { WorkflowSheetSection as PanelSection } from "@/components/workflow/WorkflowSheet";
import { cn } from "@/lib/utils";

interface CreatePayrollDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  employees: any[];
  totalMonthlyPayroll: number;
  formData: { pay_period_start: string; pay_period_end: string; payment_date: string };
  onFormDataChange: (data: { pay_period_start: string; pay_period_end: string; payment_date: string }) => void;
  variableEarnings: VEInput[];
  onVariableEarningsChange: (ve: VEInput[]) => void;
  onPreview: (e: React.FormEvent) => void;
  isLoadingPreview: boolean;
  selectedEmployeeIds: Set<string>;
  onSelectedEmployeeIdsChange: (ids: Set<string>) => void;
  runType: string;
  onRunTypeChange: (t: string) => void;
  parentRunId: string | null;
  onParentRunIdChange: (id: string | null) => void;
  candidateParentRuns?: { id: string; payroll_number: string; status: string }[];
  existingRegularRun?: { id: string; payroll_number: string; status: string } | null;
}

export function CreatePayrollDialog({
  open, onOpenChange, employees, totalMonthlyPayroll,
  formData, onFormDataChange, variableEarnings, onVariableEarningsChange,
  onPreview, isLoadingPreview,
  selectedEmployeeIds, onSelectedEmployeeIdsChange,
  runType, onRunTypeChange,
  parentRunId, onParentRunIdChange,
  candidateParentRuns = [],
  existingRegularRun = null,
}: CreatePayrollDialogProps) {
  const { formatCurrency } = useCurrency();
  const [empSearch, setEmpSearch] = useState("");
  const periodComplete = !!(formData.pay_period_start && formData.pay_period_end);
  const [manualDatesOpen, setManualDatesOpen] = useState(!periodComplete);
  const [variableOpen, setVariableOpen] = useState(false);

  const allSelected = selectedEmployeeIds.size === 0;
  const selectedCount = allSelected ? employees.length : selectedEmployeeIds.size;

  const filteredEmployees = useMemo(() => {
    const q = empSearch.trim().toLowerCase();
    if (!q) return employees;
    return employees.filter((e: any) =>
      [e.first_name, e.last_name, e.employee_number, e.email]
        .filter(Boolean)
        .some((f: string) => String(f).toLowerCase().includes(q)),
    );
  }, [employees, empSearch]);

  const toggleEmployee = (id: string, checked: boolean) => {
    const base = allSelected
      ? new Set<string>(employees.map((e: any) => e.id))
      : new Set(selectedEmployeeIds);
    if (checked) base.add(id);
    else base.delete(id);
    onSelectedEmployeeIdsChange(base);
  };

  const selectAll = () => onSelectedEmployeeIdsChange(new Set());
  const clearAll = () => onSelectedEmployeeIdsChange(new Set<string>(["__none__"]));

  const effectiveEmployeeIds = useMemo<string[]>(() => {
    if (allSelected) return employees.map((e: any) => e.id);
    const ids = employees.map((e: any) => e.id);
    return Array.from(selectedEmployeeIds).filter((id) => ids.includes(id));
  }, [allSelected, employees, selectedEmployeeIds]);

  const runTypeLabel: Record<string, string> = {
    regular: "Regular cycle",
    off_cycle: "Off-cycle",
    bonus: "Bonus",
    commission: "Commission",
    "13th_month": "13th-month / annual",
    termination: "Termination / final pay",
    supplemental: "Supplemental",
    correction: "Correction",
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:!max-w-5xl p-0 flex flex-col overflow-hidden"
      >
        <SheetHeader className="px-5 py-4 border-b shrink-0">
          <SheetTitle className="text-base sm:text-lg">Create Payroll Run</SheetTitle>
          <SheetDescription className="text-xs sm:text-sm">
            Configure the run type, period, scope and any variable earnings before previewing.
          </SheetDescription>
        </SheetHeader>

        <form onSubmit={onPreview} className="flex-1 flex flex-col min-h-0">
          <div className="flex-1 overflow-y-auto">
            <div className="px-4 sm:px-5 py-4 space-y-4">
              {/* Conflict banner — full width */}
              {existingRegularRun && runType === "regular" && (
                <div
                  role="alert"
                  className="rounded-md border border-amber-300/60 bg-amber-50 dark:bg-amber-950/30 p-3 text-xs sm:text-sm space-y-2"
                >
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="h-4 w-4 mt-0.5 text-amber-700 dark:text-amber-300 shrink-0" />
                    <div className="min-w-0 space-y-1">
                      <div className="font-medium text-amber-900 dark:text-amber-200">
                        {existingRegularRun.payroll_number} ({existingRegularRun.status}) is already the regular run for this period.
                      </div>
                      <p className="text-amber-800 dark:text-amber-300">
                        Only one regular run is allowed per period. For a late hire or one-off payment, switch to Off-cycle.
                        Use Correction to post a signed delta against {existingRegularRun.payroll_number}.
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2 pt-1 pl-6">
                    <Button type="button" size="sm" variant="outline"
                      onClick={() => { onRunTypeChange("off_cycle"); onParentRunIdChange(null); }}>
                      Switch to Off-cycle
                    </Button>
                    <Button type="button" size="sm" variant="outline"
                      onClick={() => { onRunTypeChange("correction"); onParentRunIdChange(existingRegularRun.id); }}>
                      Switch to Correction
                    </Button>
                  </div>
                </div>
              )}

              {/* Two-column grid on lg+, single column below */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {/* 1 — Run type & scope */}
                <PanelSection
                  number={1}
                  title="Run Type & Scope"
                  subtitle="Determines posting rules and whether a parent run is required."
                  id="panel-run-type"
                >
                  <div className="space-y-1.5">
                    <Label className="text-xs sm:text-sm">Run type *</Label>
                    <Select value={runType} onValueChange={onRunTypeChange}>
                      <SelectTrigger className="text-sm"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="regular">Regular cycle</SelectItem>
                        <SelectItem value="off_cycle">Off-cycle (late hire / one-off payment)</SelectItem>
                        <SelectItem value="bonus">Bonus</SelectItem>
                        <SelectItem value="commission">Commission</SelectItem>
                        <SelectItem value="13th_month">13th-month / annual</SelectItem>
                        <SelectItem value="termination">Termination / final pay</SelectItem>
                        <SelectItem value="supplemental">Supplemental (adds to a posted run)</SelectItem>
                        <SelectItem value="correction">Correction (signed delta to a posted run)</SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-[11px] text-muted-foreground">
                      Only one <b>regular</b> run per period. All other types may coexist with the regular run.
                    </p>
                  </div>

                  {(runType === "correction" || runType === "supplemental") && (
                    <div className="space-y-1.5">
                      <Label className="text-xs sm:text-sm">Parent run *</Label>
                      <Select value={parentRunId ?? ""} onValueChange={(v) => onParentRunIdChange(v || null)}>
                        <SelectTrigger className="text-sm">
                          <SelectValue placeholder={candidateParentRuns.length ? "Select posted run" : "No posted run in this period"} />
                        </SelectTrigger>
                        <SelectContent>
                          {candidateParentRuns.map(r => (
                            <SelectItem key={r.id} value={r.id}>{r.payroll_number} · {r.status}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-[11px] text-muted-foreground">
                        The posted run this {runType} adjusts. Must be in the same period.
                      </p>
                    </div>
                  )}
                </PanelSection>

                {/* 2 — Pay period */}
                <PanelSection
                  number={2}
                  title="Pay Period"
                  subtitle="Pick a preset or set start, end and payment dates manually."
                  id="panel-period"
                >
                  <PayrollPeriodSelector value={formData} onChange={onFormDataChange} />

                  <Collapsible open={manualDatesOpen} onOpenChange={setManualDatesOpen}>
                    <CollapsibleTrigger asChild>
                      <button
                        type="button"
                        className="flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground"
                      >
                        <ChevronDown className={cn("h-3 w-3 transition-transform", manualDatesOpen && "rotate-180")} />
                        Manual date override
                      </button>
                    </CollapsibleTrigger>
                    <CollapsibleContent className="space-y-3 pt-2">
                      <div className="grid gap-3 grid-cols-1 sm:grid-cols-2">
                        <div className="space-y-1.5">
                          <Label htmlFor="pay_period_start" className="text-xs sm:text-sm">Period Start *</Label>
                          <Input id="pay_period_start" type="date" className="text-sm w-full"
                            value={formData.pay_period_start}
                            onChange={(e) => onFormDataChange({ ...formData, pay_period_start: e.target.value })}
                            required />
                        </div>
                        <div className="space-y-1.5">
                          <Label htmlFor="pay_period_end" className="text-xs sm:text-sm">Period End *</Label>
                          <Input id="pay_period_end" type="date" className="text-sm w-full"
                            value={formData.pay_period_end}
                            onChange={(e) => onFormDataChange({ ...formData, pay_period_end: e.target.value })}
                            required />
                        </div>
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="payment_date" className="text-xs sm:text-sm">Payment Date *</Label>
                        <Input id="payment_date" type="date" className="text-sm w-full"
                          value={formData.payment_date}
                          onChange={(e) => onFormDataChange({ ...formData, payment_date: e.target.value })}
                          required />
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                </PanelSection>

                {/* 3 — Employees */}
                <PanelSection
                  number={3}
                  title="Employees"
                  subtitle="Default is all active employees. Narrow the scope for one-off runs."
                  id="panel-employees"
                >
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button type="button" variant="outline" className="w-full justify-between font-normal">
                        <span className="flex items-center gap-2 truncate">
                          <Users className="h-4 w-4" />
                          {allSelected
                            ? `All active employees (${employees.length})`
                            : `${selectedCount} of ${employees.length} selected`}
                        </span>
                        <ChevronDown className="h-4 w-4 opacity-60" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
                      <div className="p-2 border-b space-y-2">
                        <Input placeholder="Search employees..." value={empSearch}
                          onChange={(e) => setEmpSearch(e.target.value)} className="h-8 text-xs" />
                        <div className="flex items-center justify-between text-xs">
                          <button type="button" className="text-primary hover:underline" onClick={selectAll}>Select all</button>
                          <button type="button" className="text-muted-foreground hover:underline" onClick={clearAll}>Clear</button>
                        </div>
                      </div>
                      <ScrollArea className="h-[220px]">
                        <div className="p-1">
                          {filteredEmployees.length === 0 && (
                            <div className="px-3 py-6 text-center text-xs text-muted-foreground">No employees match.</div>
                          )}
                          {filteredEmployees.map((e: any) => {
                            const checked = allSelected || selectedEmployeeIds.has(e.id);
                            return (
                              <label key={e.id}
                                className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-accent cursor-pointer text-sm">
                                <Checkbox checked={checked} onCheckedChange={(c) => toggleEmployee(e.id, !!c)} />
                                <span className="flex-1 truncate">
                                  {e.first_name} {e.last_name}
                                  {e.employee_number ? (
                                    <span className="text-xs text-muted-foreground"> · {e.employee_number}</span>
                                  ) : null}
                                </span>
                              </label>
                            );
                          })}
                        </div>
                      </ScrollArea>
                    </PopoverContent>
                  </Popover>
                  <p className="text-[11px] text-muted-foreground">
                    Pick a single employee for an off-cycle/correction run, or leave at "All active" for the regular cycle.
                  </p>
                </PanelSection>

                {/* 4 — Pre-run readiness */}
                <PanelSection
                  number={4}
                  title="Pre-run Readiness"
                  subtitle="Server-side checks before posting. Run is blocked if any hard check fails."
                  id="panel-readiness"
                >
                  <PreRunReadinessSummary
                    employeeIds={effectiveEmployeeIds}
                    active={open}
                    periodStart={formData.pay_period_start}
                    periodEnd={formData.pay_period_end}
                  />
                </PanelSection>
              </div>

              {/* 5 — Variable earnings (full width, collapsed by default) */}
              <PanelSection
                number={5}
                title="Variable Earnings"
                subtitle="Bonuses, commissions and ad-hoc adjustments layered on top of base pay."
                id="panel-variable"
                right={
                  <div className="flex items-center gap-2">
                    {variableEarnings.length > 0 && (
                      <Badge variant="secondary" className="text-[10px]">{variableEarnings.length}</Badge>
                    )}
                    <Button type="button" variant="ghost" size="sm"
                      className="h-7 px-2 text-xs"
                      onClick={() => setVariableOpen((v) => !v)}>
                      <ChevronDown className={cn("h-3.5 w-3.5 mr-1 transition-transform", variableOpen && "rotate-180")} />
                      {variableOpen ? "Hide" : "Show"}
                    </Button>
                  </div>
                }
              >
                {variableOpen ? (
                  <VariableEarningsInput
                    employees={employees}
                    value={variableEarnings}
                    onChange={onVariableEarningsChange}
                  />
                ) : (
                  <p className="text-[11px] text-muted-foreground">
                    {variableEarnings.length === 0
                      ? "No variable earnings added. Most regular runs do not need any."
                      : `${variableEarnings.length} variable earning${variableEarnings.length === 1 ? "" : "s"} configured.`}
                  </p>
                )}
              </PanelSection>
            </div>
          </div>

          {/* Sticky summary + actions */}
          <div className="border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 px-4 sm:px-5 py-3 shrink-0">
            <div className="flex flex-col lg:flex-row lg:items-center gap-3">
              <Card className="bg-muted/40 border-0 shadow-none flex-1 min-w-0">
                <CardContent className="p-2 sm:p-3 flex flex-wrap items-center gap-x-6 gap-y-1">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-xs text-muted-foreground">Run type:</span>
                    <span className="text-xs font-medium truncate">{runTypeLabel[runType] ?? runType}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">Employees:</span>
                    <span className="text-xs font-medium">{selectedCount}</span>
                  </div>
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-xs text-muted-foreground">Estimated total:</span>
                    <span className="text-xs font-semibold truncate">{formatCurrency(totalMonthlyPayroll)}</span>
                  </div>
                </CardContent>
              </Card>
              <div className="flex flex-col-reverse sm:flex-row gap-2 sm:justify-end">
                <Button type="button" variant="outline" onClick={() => onOpenChange(false)} className="w-full sm:w-auto">
                  Cancel
                </Button>
                <Button type="submit" disabled={isLoadingPreview} className="w-full sm:w-auto">
                  {isLoadingPreview && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  <Eye className="mr-2 h-4 w-4" /> Preview Payroll
                </Button>
              </div>
            </div>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
}
