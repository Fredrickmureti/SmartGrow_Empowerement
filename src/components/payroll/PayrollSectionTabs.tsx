/**
 * PayrollSectionTabs — in-page mini tabs for the Employee → Payroll pane.
 *
 * Splits the four heavy payroll panels (Readiness, Compensation & identifiers,
 * Custom deductions, Payslips) into switchable tabs so users don't scroll
 * through the full stack to reach one panel. Active tab persists to the
 * `?ptab=` search param so deep links keep working alongside the sidebar
 * `?section=payroll` param.
 */
import { useSearchParams } from "react-router-dom";
import { ShieldCheck, Wallet, MinusCircle, Receipt } from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { EmployeeReadinessPanel } from "@/components/payroll/EmployeeReadinessPanel";
import { EmployeePayrollInfo } from "@/components/employees/EmployeePayrollInfo";
import { EmployeeCustomDeductionsSection } from "@/components/payroll/EmployeeCustomDeductionsSection";
import { EmployeePayslipHistory } from "@/components/employees/EmployeePayslipHistory";

interface Props {
  employee: any;
  canViewPayrollRuns: boolean;
  canViewEmpPayroll: boolean;
}

type Tab = "readiness" | "compensation" | "deductions" | "payslips";

export function PayrollSectionTabs({ employee, canViewPayrollRuns, canViewEmpPayroll }: Props) {
  const [params, setParams] = useSearchParams();

  const available: Array<{ id: Tab; label: string; icon: typeof ShieldCheck }> = [];
  if (canViewPayrollRuns) available.push({ id: "readiness", label: "Readiness", icon: ShieldCheck });
  if (canViewEmpPayroll) available.push({ id: "compensation", label: "Compensation", icon: Wallet });
  if (canViewEmpPayroll) available.push({ id: "deductions", label: "Custom deductions", icon: MinusCircle });
  if (canViewPayrollRuns) available.push({ id: "payslips", label: "Payslips", icon: Receipt });

  if (available.length === 0) return null;

  const requested = (params.get("ptab") as Tab | null) ?? undefined;
  const active: Tab = available.find((t) => t.id === requested)?.id ?? available[0].id;

  const setActive = (next: string) => {
    const p = new URLSearchParams(params);
    p.set("ptab", next);
    setParams(p, { replace: true });
  };

  return (
    <Tabs value={active} onValueChange={setActive} className="w-full">
      <TabsList className="w-full justify-start flex-wrap h-auto">
        {available.map((t) => (
          <TabsTrigger key={t.id} value={t.id} className="gap-2">
            <t.icon className="h-4 w-4" />
            {t.label}
          </TabsTrigger>
        ))}
      </TabsList>

      {canViewPayrollRuns && (
        <TabsContent value="readiness" className="mt-4">
          <EmployeeReadinessPanel employeeId={employee.id} />
        </TabsContent>
      )}
      {canViewEmpPayroll && (
        <TabsContent value="compensation" className="mt-4">
          <EmployeePayrollInfo employee={employee} />
        </TabsContent>
      )}
      {canViewEmpPayroll && (
        <TabsContent value="deductions" className="mt-4">
          <EmployeeCustomDeductionsSection employeeId={employee.id} />
        </TabsContent>
      )}
      {canViewPayrollRuns && (
        <TabsContent value="payslips" className="mt-4">
          <EmployeePayslipHistory employeeId={employee.id} />
        </TabsContent>
      )}
    </Tabs>
  );
}

export default PayrollSectionTabs;