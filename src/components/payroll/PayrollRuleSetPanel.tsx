/**
 * R3.1 — Read-only display of the immutable rule sets stamped onto a payroll
 * run's payslips. Renders the JSONB snapshot, NOT live salary_components.
 */
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Loader2 } from "lucide-react";
import { useRuleSetsForRun } from "@/hooks/payroll/useSalaryRuleSets";

export function RuleSetComponentsTable({ components }: { components: any[] }) {
  if (!components || components.length === 0) {
    return <p className="text-sm text-muted-foreground p-4">No components in this rule set.</p>;
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Code</TableHead>
          <TableHead>Name</TableHead>
          <TableHead>Type</TableHead>
          <TableHead>Computation</TableHead>
          <TableHead className="text-right">Value</TableHead>
          <TableHead>Taxable</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {components.map((c: any, i: number) => (
          <TableRow key={c.code ?? i}>
            <TableCell className="font-mono text-xs">{c.code}</TableCell>
            <TableCell>{c.name}</TableCell>
            <TableCell><Badge variant="outline">{c.component_type}</Badge></TableCell>
            <TableCell className="text-xs">{c.computation_type}</TableCell>
            <TableCell className="text-right">{c.computation_value ?? "—"}</TableCell>
            <TableCell>{c.is_taxable ? "Yes" : "No"}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

interface PayrollRuleSetPanelProps {
  payrollRunId: string;
}

export function PayrollRuleSetPanel({ payrollRunId }: PayrollRuleSetPanelProps) {
  const { data, isLoading } = useRuleSetsForRun(payrollRunId);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground p-4">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading rule sets…
      </div>
    );
  }
  if (!data || data.length === 0) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground">
          No rule sets stamped on this run yet. Run payroll computation first — every payslip will be locked to an immutable salary structure version.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        These are the frozen rule sets used to compute this run. Future edits to the underlying salary structure cannot change historical payslips.
      </p>
      {data.map((rs) => (
        <Card key={rs.id}>
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <div>
              <CardTitle className="text-base">
                {rs.structure_name ?? "Unknown structure"}
                {rs.structure_code && <span className="text-muted-foreground font-normal text-xs ml-2">{rs.structure_code}</span>}
              </CardTitle>
              <p className="text-xs text-muted-foreground mt-1">
                v{rs.version} · <span className="font-mono">{rs.rule_hash.slice(0, 8)}</span> · effective {rs.effective_from}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant={rs.status === "active" ? "outline" : "secondary"}>{rs.status}</Badge>
              <Badge variant="secondary">{rs.employee_count} employee{rs.employee_count === 1 ? "" : "s"}</Badge>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <RuleSetComponentsTable components={rs.components} />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
