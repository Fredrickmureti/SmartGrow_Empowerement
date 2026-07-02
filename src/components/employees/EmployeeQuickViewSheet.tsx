/**
 * EmployeeQuickViewSheet — lightweight side panel for HR users to inspect
 * an employee at a glance without navigating away from the directory.
 *
 * Surfaces identity, contact, employment + compensation summary, and a CTA
 * to open the full profile.
 */
import { useNavigate } from "react-router-dom";
import { format } from "date-fns";
import {
  Mail, Phone, MapPin, Briefcase, Calendar, Building2,
  CreditCard, Banknote, UserCheck, UserX, ArrowRight,
} from "lucide-react";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetFooter,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { Employee } from "@/hooks/useEmployees";
import { useCurrency } from "@/hooks/useCurrency";
import { usePermissions } from "@/hooks/usePermissions";
import { useEmployeeStatutoryIdentifiers } from "@/hooks/employees/useEmployeeStatutoryIdentifiers";

interface Props {
  employee: Employee | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function initials(e: Employee) {
  return `${e.first_name?.[0] ?? ""}${e.last_name?.[0] ?? ""}`.toUpperCase() || "??";
}

function Row({ icon: Icon, label, value }: { icon: any; label: string; value: React.ReactNode }) {
  if (value === null || value === undefined || value === "" || value === "—") return null;
  return (
    <div className="flex items-start gap-3 py-2">
      <Icon className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="text-sm font-medium break-words">{value}</div>
      </div>
    </div>
  );
}

export function EmployeeQuickViewSheet({ employee, open, onOpenChange }: Props) {
  const navigate = useNavigate();
  const { formatCurrency } = useCurrency();
  const { can } = usePermissions();
  const { data: statutory = [] } = useEmployeeStatutoryIdentifiers(employee?.id ?? null);

  if (!employee) return null;

  const e = employee;
  const fullName = `${e.first_name} ${e.last_name}`.trim();
  const grossPay =
    (e.basic_salary ?? 0) + (e.housing_allowance ?? 0) + (e.transport_allowance ?? 0);
  const address = [e.address_line1, e.address_line2, e.city, e.county, e.country]
    .filter(Boolean)
    .join(", ");

  const goToProfile = () => {
    onOpenChange(false);
    navigate(`/hr/employees/${e.id}`);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-md p-0 flex flex-col">
        <SheetHeader className="px-6 pt-6 pb-4 border-b">
          <div className="flex items-start gap-4">
            <Avatar className="h-14 w-14">
              <AvatarFallback className="text-base">{initials(e)}</AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <SheetTitle className="text-left text-lg truncate">{fullName}</SheetTitle>
              <SheetDescription className="text-left flex items-center gap-2 flex-wrap mt-1">
                <span className="font-mono text-xs">#{e.employee_number}</span>
                {e.is_active ? (
                  <Badge variant="outline" className="gap-1">
                    <UserCheck className="h-3 w-3" /> Active
                  </Badge>
                ) : (
                  <Badge variant="secondary" className="gap-1">
                    <UserX className="h-3 w-3" /> Inactive
                  </Badge>
                )}
                {e.employment_type && (
                  <Badge variant="outline" className="capitalize">
                    {e.employment_type.replace(/_/g, " ")}
                  </Badge>
                )}
              </SheetDescription>
            </div>
          </div>
        </SheetHeader>

        <ScrollArea className="flex-1">
          <div className="px-6 py-4 space-y-4">
            <section>
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">
                Contact
              </h3>
              <Row icon={Mail} label="Email" value={e.email || "—"} />
              <Row icon={Phone} label="Phone" value={e.phone || "—"} />
              {address && <Row icon={MapPin} label="Address" value={address} />}
            </section>

            <Separator />

            <section>
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">
                Employment
              </h3>
              <Row icon={Building2} label="Department" value={e.department_name || e.department || "—"} />
              <Row icon={Briefcase} label="Position" value={e.position || "—"} />
              <Row
                icon={Calendar}
                label="Hire date"
                value={e.hire_date ? format(new Date(e.hire_date), "MMM d, yyyy") : "—"}
              />
              {e.termination_date && (
                <Row
                  icon={Calendar}
                  label="Termination date"
                  value={format(new Date(e.termination_date), "MMM d, yyyy")}
                />
              )}
              {e.manager && (
                <Row
                  icon={UserCheck}
                  label="Manager"
                  value={`${e.manager.first_name} ${e.manager.last_name}`}
                />
              )}
            </section>

            {can("viewPayroll") && (
              <>
                <Separator />
                <section>
                  <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">
                    Compensation
                  </h3>
                  <Row icon={Banknote} label="Basic salary" value={formatCurrency(e.basic_salary ?? 0)} />
                  {(e.housing_allowance ?? 0) > 0 && (
                    <Row icon={Banknote} label="Housing allowance" value={formatCurrency(e.housing_allowance)} />
                  )}
                  {(e.transport_allowance ?? 0) > 0 && (
                    <Row icon={Banknote} label="Transport allowance" value={formatCurrency(e.transport_allowance)} />
                  )}
                  <Row icon={Banknote} label="Gross pay" value={<span className="font-semibold">{formatCurrency(grossPay)}</span>} />
                </section>
              </>
            )}

            {(e.national_id || statutory.length > 0) && (
              <>
                <Separator />
                <section>
                  <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">
                    Statutory
                  </h3>
                  {e.national_id && (
                    <Row icon={CreditCard} label="National ID" value={e.national_id} />
                  )}
                  {statutory.map((row) => (
                    <Row key={row.id} icon={CreditCard} label={row.label} value={row.identifier_value} />
                  ))}
                </section>
              </>
            )}
          </div>
        </ScrollArea>

        <SheetFooter className="px-6 py-4 border-t flex-row gap-2 sm:justify-between">
          <Button variant="outline" onClick={() => onOpenChange(false)} className="flex-1 sm:flex-none">
            Close
          </Button>
          <Button onClick={goToProfile} className="flex-1 sm:flex-none">
            View full profile <ArrowRight className="ml-2 h-4 w-4" />
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
