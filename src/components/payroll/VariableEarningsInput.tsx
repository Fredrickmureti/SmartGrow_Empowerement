import { useState } from "react";
import { Link } from "react-router-dom";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ChevronDown, ChevronRight, AlertCircle, Loader2 } from "lucide-react";
import { Employee } from "@/hooks/useEmployees";
import { VariableEarningsInput as VEInput } from "@/hooks/usePayroll";
import {
  useVariableInputTypes,
  type PayrollInputType,
  type PayrollInputUnit,
} from "@/hooks/payroll/useVariableInputTypes";

interface VariableEarningsInputProps {
  employees: Employee[];
  value: VEInput[];
  onChange: (earnings: VEInput[]) => void;
  /** Active salary structure id. When set, restricts the rendered input
   * types to those whose `structure_ids` permits this structure
   * (empty `structure_ids` means "all structures"). */
  structureId?: string;
}

const UNIT_PLACEHOLDER: Record<PayrollInputUnit, string> = {
  amount: "0.00",
  hours: "0 hrs",
  days: "0 d",
  count: "0",
};

const UNIT_STEP: Record<PayrollInputUnit, string> = {
  amount: "0.01",
  hours: "0.25",
  days: "0.5",
  count: "1",
};

/**
 * Phase 4 P1.2e — pack-driven variable-input grid.
 *
 * Columns are derived from `payroll_input_types` — the country-agnostic
 * registry equivalent to Odoo `hr.payslip.input.type`, SAP wage-type
 * permissibility, and Workday pay-component input templates. Each
 * column writes into the payload keyed by `inputType.code` (the same
 * key the payroll engine looks up). No hardcoded country-specific
 * columns live here.
 *
 * Empty registry → explicit "configure a pack" notice. No country
 * defaults, ever.
 */
export function VariableEarningsInput({
  employees,
  value,
  onChange,
  structureId,
}: VariableEarningsInputProps) {
  const [isOpen, setIsOpen] = useState(false);
  const { data: inputTypes = [], isLoading } = useVariableInputTypes(structureId);

  const getEarning = (empId: string): VEInput =>
    value.find((v) => v.employee_id === empId) || { employee_id: empId };

  const updateEarning = (empId: string, code: string, amount: number) => {
    const existing = value.find((v) => v.employee_id === empId);
    const updated: VEInput = existing
      ? { ...existing, [code]: amount || undefined }
      : { employee_id: empId, [code]: amount || undefined };

    const cleaned: VEInput = { employee_id: empId };
    for (const [k, v] of Object.entries(updated)) {
      if (k === "employee_id") continue;
      if (typeof v === "number" && v > 0) cleaned[k] = v;
    }

    const next = value.filter((v) => v.employee_id !== empId);
    if (Object.keys(cleaned).length > 1) next.push(cleaned);
    onChange(next);
  };

  const clampForType = (raw: number, t: PayrollInputType): number => {
    if (Number.isNaN(raw) || raw < 0) return 0;
    if (t.max_value != null && raw > Number(t.max_value)) return Number(t.max_value);
    if (t.min_value != null && raw > 0 && raw < Number(t.min_value)) return Number(t.min_value);
    return raw;
  };

  const hasAnyEarnings = value.length > 0;
  const summary = inputTypes.length > 0
    ? inputTypes.map((t) => t.name).slice(0, 3).join(", ") +
      (inputTypes.length > 3 ? ", …" : "")
    : "no pack-declared inputs";

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <CollapsibleTrigger asChild>
        <Button variant="ghost" className="w-full justify-between p-2 h-auto" type="button">
          <span className="text-sm font-medium text-left">
            Variable Inputs
            <span className="ml-2 text-xs text-muted-foreground font-normal">
              ({summary})
            </span>
            {hasAnyEarnings && (
              <span className="ml-2 text-xs text-primary">
                — {value.length} employee{value.length > 1 ? "s" : ""}
              </span>
            )}
          </span>
          {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        {isLoading ? (
          <div className="border rounded-md mt-2 p-4 flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading pack-declared input types…
          </div>
        ) : inputTypes.length === 0 ? (
          <div className="border rounded-md mt-2 p-4 flex items-start gap-3 bg-muted/40">
            <AlertCircle className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
            <div className="text-xs leading-relaxed">
              <p className="font-medium">No variable inputs set up yet.</p>
              <p className="text-muted-foreground mt-1">
                Variable inputs are the per-run amounts you type in here —
                overtime, bonus, commission, arrears. Define them once in{" "}
                <Link
                  to="/hr/payroll/configuration/input-types"
                  className="underline underline-offset-2 font-medium text-foreground"
                >
                  Payroll → Configuration → Variable Input Types
                </Link>{" "}
                (there's a one-click standard set) and each one appears as a
                column here. Nothing is locked — the grid simply has no
                columns to show until you declare them.
              </p>
            </div>
          </div>
        ) : (
          <div className="border rounded-md mt-2 overflow-auto max-h-[300px]">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs sticky left-0 bg-background">Employee</TableHead>
                  {inputTypes.map((t) => (
                    <TableHead
                      key={t.id}
                      className="text-xs text-right w-28"
                      title={`${t.code} · ${t.input_unit}${t.description ? ` — ${t.description}` : ""}`}
                    >
                      {t.name}
                      <span className="block text-[10px] font-normal text-muted-foreground">
                        {t.input_unit}
                        {t.is_required ? " · required" : ""}
                      </span>
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {employees.map((emp) => {
                  const earning = getEarning(emp.id);
                  return (
                    <TableRow key={emp.id}>
                      <TableCell className="text-xs font-medium sticky left-0 bg-background">
                        {emp.first_name} {emp.last_name}
                      </TableCell>
                      {inputTypes.map((t) => (
                        <TableCell key={t.id} className="p-1">
                          <Input
                            type="number"
                            min={t.min_value ?? 0}
                            max={t.max_value ?? undefined}
                            step={UNIT_STEP[t.input_unit]}
                            placeholder={UNIT_PLACEHOLDER[t.input_unit]}
                            className="h-7 text-xs text-right"
                            value={(earning[t.code] as number | undefined) || ""}
                            onChange={(e) => {
                              const raw = parseFloat(e.target.value);
                              updateEarning(emp.id, t.code, clampForType(raw, t));
                            }}
                          />
                        </TableCell>
                      ))}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
