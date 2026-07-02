/**
 * PayslipHeader — single render of the employer / employee / period /
 * statutory-identifier block. Used identically by the admin
 * PayslipDetailDialog and the employee portal payslip view.
 *
 * The component is country-agnostic: every statutory identifier is a
 * row in `employee_statutory_identifiers` /
 * `organization_statutory_identifiers` whose label is humanised by
 * `labelForIdentifier`. NEVER add a country branch here — extend
 * `pack_requirements` and the localization pack instead.
 */
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { PayslipHeaderModel, PayslipStatutoryId } from "@/lib/payroll/payslipHeader";

interface Props {
  header: PayslipHeaderModel;
  /** Employee-self-service view hides admin-only signals (e.g. missing-required warnings). */
  portalMode?: boolean;
}

function IdList({ ids }: { ids: PayslipStatutoryId[] }) {
  if (!ids.length) return null;
  return (
    <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-xs">
      {ids.map((id) => (
        <div key={id.identifier_type} className="flex justify-between gap-2 min-w-0">
          <dt className="text-muted-foreground truncate">{id.label}</dt>
          <dd className="font-medium tabular-nums truncate">{id.identifier_value ?? "—"}</dd>
        </div>
      ))}
    </dl>
  );
}

export function PayslipHeader({ header, portalMode = false }: Props) {
  const { employer, employee, notes } = header;
  // Consumed IDs anchor each card. Declared-only IDs surface as a small
  // secondary line in admin mode and are hidden entirely in portal mode
  // (employees should not see registrations that aren't tied to this
  // run's withholdings — ADR-0036 §I9).
  const employerConsumed = employer.statutory_ids.filter((x) => x.relevance === "consumed");
  const employerDeclared = employer.statutory_ids.filter((x) => x.relevance === "declared");
  const employeeConsumed = employee.statutory_ids.filter((x) => x.relevance === "consumed");
  const employeeDeclared = employee.statutory_ids.filter((x) => x.relevance === "declared");

  return (
    <div className="grid gap-3 md:grid-cols-2">
      <Card>
        <CardContent className="p-3 space-y-2">
          <div>
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Employer</div>
            <div className="font-medium text-sm">{employer.name ?? "—"}</div>
          </div>
          <IdList ids={employerConsumed} />
          {!portalMode && employerDeclared.length > 0 && (
            <div className="text-[10px] text-muted-foreground/70 pt-1 border-t">
              Other registrations on file: {employerDeclared.map((x) => x.label).join(", ")}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-3 space-y-2">
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Employee</div>
              <div className="font-medium text-sm">{employee.name}</div>
              <div className="text-xs text-muted-foreground">
                {[employee.employee_number, employee.position, employee.department]
                  .filter(Boolean)
                  .join(" · ") || ""}
              </div>
            </div>
            {employee.country_code && (
              <Badge variant="outline" className="text-[10px]">{employee.country_code}</Badge>
            )}
          </div>
          <IdList ids={employeeConsumed} />
          {!portalMode && employeeDeclared.length > 0 && (
            <div className="text-[10px] text-muted-foreground/70">
              Other identifiers on file: {employeeDeclared.map((x) => x.label).join(", ")}
            </div>
          )}
          {(employee.bank_name || employee.bank_account_masked) && (
            <div className="text-xs text-muted-foreground pt-1 border-t">
              {[employee.bank_name, employee.bank_branch && `(${employee.bank_branch})`, employee.bank_account_masked]
                .filter(Boolean)
                .join(" · ")}
            </div>
          )}
        </CardContent>
      </Card>

      {!portalMode && notes.length > 0 && (
        <div className="md:col-span-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-xs">
          {notes.map((n, i) => (
            <div key={i} className="text-amber-700 dark:text-amber-400">{n.message}</div>
          ))}
        </div>
      )}
    </div>
  );
}
