/**
 * EmployeePayrollInfo — read-only compensation, bank, and statutory IDs
 * shown inside the Payroll section of the employee profile.
 *
 * Phase 3 hardening: statutory ID rows are sourced exclusively from
 * `employee_statutory_identifiers` (pack/data-driven). The legacy
 * country-typed employee columns (`tax_pin`, `nssf_number`,
 * `shif_number`, `nhif_number`) have been dropped from the schema.
 */
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useCurrency } from "@/hooks/useCurrency";
import { useEmployeeStatutoryIdentifiers } from "@/hooks/employees/useEmployeeStatutoryIdentifiers";
import type { EmployeeProfile } from "@/hooks/useEmployeeProfile";

interface Props {
  employee: EmployeeProfile;
}

function Row({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center gap-1 py-2 border-b border-border/50 last:border-0">
      <span className="text-sm text-muted-foreground w-44 shrink-0">{label}</span>
      <span className="text-sm font-medium">{value || "—"}</span>
    </div>
  );
}

export function EmployeePayrollInfo({ employee }: Props) {
  const { formatCurrency } = useCurrency();
  const { data: identifiers = [], isLoading } = useEmployeeStatutoryIdentifiers(employee.id);

  const otherTotal = employee.other_allowances
    ? Object.values(employee.other_allowances).reduce((a, b) => a + (Number(b) || 0), 0)
    : 0;
  const grossMonthly =
    (employee.basic_salary || 0) +
    (employee.housing_allowance || 0) +
    (employee.transport_allowance || 0) +
    otherTotal;


  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Compensation</CardTitle>
        </CardHeader>
        <CardContent className="space-y-0">
          <Row label="Basic salary" value={formatCurrency(employee.basic_salary || 0)} />
          <Row label="Housing allowance" value={formatCurrency(employee.housing_allowance || 0)} />
          <Row label="Transport allowance" value={formatCurrency(employee.transport_allowance || 0)} />
          <Row label="Other allowances" value={formatCurrency(otherTotal)} />
          <Row label="Gross monthly" value={formatCurrency(grossMonthly)} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Bank details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-0">
          <Row label="Bank name" value={employee.bank_name} />
          <Row label="Branch" value={employee.bank_branch} />
          <Row label="Account number" value={employee.bank_account_number} />
          <Row label="Bank code" value={employee.bank_code} />
        </CardContent>
      </Card>

      <Card className="md:col-span-2">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Statutory identifiers</CardTitle>
        </CardHeader>
        <CardContent className="space-y-0">
          {isLoading ? (
            <span className="text-sm text-muted-foreground">Loading…</span>
          ) : identifiers.length > 0 ? (
            identifiers.map((row) => (
              <Row key={row.id} label={row.label} value={row.identifier_value} />
            ))
          ) : (
            <span className="text-sm text-muted-foreground">
              No statutory identifiers on file.
            </span>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
