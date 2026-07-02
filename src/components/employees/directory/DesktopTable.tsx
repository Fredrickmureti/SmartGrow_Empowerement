import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import type { Employee } from "@/hooks/useEmployees";
import { positionName, locationName } from "./helpers";
import { SetupHealthPill } from "./SetupHealthPill";
import type { SetupHealthRow } from "@/hooks/hr/useEmployeeSetupHealth";


export function DesktopTable({
  employees, positions, locations, canViewPayroll, formatCurrency, calculateGrossPay,
  onOpen, rowActions, selectedIds, onToggleSelected, onToggleAll, healthById,
}: {
  employees: Employee[];
  positions: { id: string; name: string }[];
  locations: { id: string; name: string }[];
  canViewPayroll: boolean;
  formatCurrency: (n: number) => string;
  calculateGrossPay: (e: Employee) => number;
  onOpen: (e: Employee) => void;
  rowActions: (e: Employee) => React.ReactNode;
  selectedIds: Set<string>;
  onToggleSelected: (id: string) => void;
  onToggleAll: (checked: boolean) => void;
  healthById?: Map<string, SetupHealthRow>;
}) {
  const allChecked = employees.length > 0 && employees.every((e) => selectedIds.has(e.id));

  return (
    <div className="table-container">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-10">
              <Checkbox
                checked={allChecked}
                onCheckedChange={(v) => onToggleAll(Boolean(v))}
                aria-label="Select all"
              />
            </TableHead>
            <TableHead>Emp #</TableHead>
            <TableHead>Name</TableHead>
            <TableHead>Department</TableHead>
            <TableHead>Position</TableHead>
            <TableHead>Location</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Health</TableHead>
            {canViewPayroll && <TableHead className="text-right">Gross Pay</TableHead>}
            <TableHead className="w-12"></TableHead>
          </TableRow>

        </TableHeader>
        <TableBody>
          {employees.map((emp) => (
            <TableRow key={emp.id} data-state={selectedIds.has(emp.id) ? "selected" : undefined}>
              <TableCell>
                <Checkbox
                  checked={selectedIds.has(emp.id)}
                  onCheckedChange={() => onToggleSelected(emp.id)}
                  aria-label={`Select ${emp.first_name}`}
                />
              </TableCell>
              <TableCell className="font-medium">{emp.employee_number}</TableCell>
              <TableCell>
                <div>
                  <div
                    className="font-medium text-primary cursor-pointer hover:underline"
                    onClick={() => onOpen(emp)}
                  >
                    {emp.first_name} {emp.last_name}
                  </div>
                  {emp.email && <div className="text-sm text-muted-foreground">{emp.email}</div>}
                </div>
              </TableCell>
              <TableCell>{emp.department_name || emp.department || "—"}</TableCell>
              <TableCell>{positionName((emp as any).job_position_id, positions) || emp.position || "—"}</TableCell>
              <TableCell>{locationName((emp as any).work_location_id, locations) || "—"}</TableCell>
              <TableCell>
                <Badge variant="outline" className="capitalize">
                  {emp.employment_type.replace("_", " ")}
                </Badge>
              </TableCell>
              <TableCell>
                <Badge
                  className={emp.is_active
                    ? "bg-success/10 text-success border-success/20"
                    : "bg-destructive/10 text-destructive border-destructive/20"}
                  variant="outline"
                >
                  {emp.is_active ? "Active" : "Inactive"}
                </Badge>
              </TableCell>
              <TableCell>
                <SetupHealthPill row={healthById?.get(emp.id)} />
              </TableCell>
              {canViewPayroll && (
                <TableCell className="text-right font-medium">
                  {formatCurrency(calculateGrossPay(emp))}
                </TableCell>
              )}

              <TableCell>{rowActions(emp)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}