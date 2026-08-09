import { formatAddressInline } from "@/lib/contactAddresses";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmployeeProfile } from "@/hooks/useEmployeeProfile";
import { useEmployeeStatutoryIdentifiers } from "@/hooks/employees/useEmployeeStatutoryIdentifiers";
import { useEmployeeRequirements } from "@/hooks/hr/useEmployeeRequirements";
import { useBusinessModules } from "@/hooks/hr/useBusinessModules";
import { format } from "date-fns";

interface Props {
  employee: EmployeeProfile;
}

function InfoRow({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center gap-1 py-2 border-b border-border/50 last:border-0">
      <span className="text-sm text-muted-foreground w-40 shrink-0">{label}</span>
      <span className="text-sm font-medium">{value || "—"}</span>
    </div>
  );
}

export function EmployeePrivateInfo({ employee }: Props) {
  const modules = useBusinessModules();
  const { statutory: statutoryRequirements } = useEmployeeRequirements({ module: "payroll" });
  const { data: identifiers = [] } = useEmployeeStatutoryIdentifiers(employee.id);
  const valueByKey = new Map(identifiers.map((i) => [i.identifier_type, i.identifier_value]));

  // One formatter for every printed/displayed address (ADR-0080).
  // Employees carry `county` where contacts carry `state`.
  const formatAddress = () =>
    formatAddressInline({
      address_line1: employee.address_line1,
      address_line2: employee.address_line2,
      city: employee.city,
      state: employee.county,
      postal_code: employee.postal_code,
      country: employee.country,
    }) || null;

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Personal Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-0">
          <InfoRow label="Gender" value={employee.gender} />
          <InfoRow label="Date of Birth" value={employee.date_of_birth ? format(new Date(employee.date_of_birth), "MMM d, yyyy") : null} />
          <InfoRow label="Marital Status" value={employee.marital_status ? employee.marital_status.charAt(0).toUpperCase() + employee.marital_status.slice(1) : null} />
          <InfoRow label="National ID" value={employee.national_id} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Contact</CardTitle>
        </CardHeader>
        <CardContent className="space-y-0">
          <InfoRow label="Personal Email" value={employee.email} />
          <InfoRow label="Personal Phone" value={employee.personal_phone} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Address</CardTitle>
        </CardHeader>
        <CardContent className="space-y-0">
          <InfoRow label="Address" value={formatAddress()} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Emergency Contact</CardTitle>
        </CardHeader>
        <CardContent className="space-y-0">
          <InfoRow label="Name" value={employee.emergency_contact_name} />
          <InfoRow label="Phone" value={employee.emergency_contact_phone} />
          <InfoRow label="Relationship" value={employee.emergency_contact_relationship} />
        </CardContent>
      </Card>

      {modules.payroll && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Statutory</CardTitle>
          </CardHeader>
          <CardContent className="space-y-0">
            {statutoryRequirements.map((field) => (
              <InfoRow
                key={field.requirement_key}
                label={field.label}
                value={valueByKey.get(field.requirement_key) ?? null}
              />
            ))}
            {statutoryRequirements.length === 0 && (
              <p className="text-sm text-muted-foreground py-2">
                No statutory identifiers required. Install a country payroll pack to enable.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Banking</CardTitle>
        </CardHeader>
        <CardContent className="space-y-0">
          <InfoRow label="Bank Name" value={employee.bank_name} />
          <InfoRow label="Branch" value={employee.bank_branch} />
          <InfoRow label="Account #" value={employee.bank_account_number} />
          <InfoRow label="Bank Code" value={employee.bank_code} />
        </CardContent>
      </Card>
    </div>
  );
}