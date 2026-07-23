/**
 * MyLegalOrders — employee self-service surface at `/me/legal-orders`.
 *
 * Read-only listing of the current employee's legal orders (garnishments,
 * child support, tax levies, etc.) sourced from the canonical
 * `public.legal_orders` view. Employees can attach supporting evidence
 * (order copy, amendment, other) via the shared LegalOrderDocuments
 * panel — RLS restricts them to their own `garnishment_id` and the
 * matching storage folder under the private `legal-orders` bucket.
 *
 * Architectural invariants preserved:
 *   • Reads go through the `public.legal_orders` view.
 *   • No writes to `legal_orders_records` from ESS.
 *   • Country-agnostic — every string label is derived from pack data.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentEmployee } from "@/hooks/useCurrentEmployee";
import { useCurrency } from "@/hooks/useCurrency";
import { PageHeader, PageBody, StatusBadge } from "@/design-system";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChevronDown, ChevronRight, Scale } from "lucide-react";
import { LegalOrderDocuments } from "@/components/payroll/LegalOrderDocuments";
import { EmployeeLinkRequired } from "@/components/me/EmployeeLinkRequired";

interface LegalOrderRow {
  id: string;
  organization_id: string;
  employee_id: string;
  kind_code: string;
  case_reference: string | null;
  authority_name: string | null;
  status: string;
  priority_class: number | null;
  start_date: string | null;
  end_date: string | null;
  total_owed: number | null;
  total_paid: number | null;
  total_accrued: number | null;
  evidence_requirements: Record<string, unknown> | null;
  notes: string | null;
}

function statusTone(status: string): "success" | "warning" | "danger" | "info" | "neutral" {
  switch (status) {
    case "active":
      return "success";
    case "pending_approval":
    case "pending":
      return "warning";
    case "rejected":
    case "revoked":
      return "danger";
    case "closed":
    case "completed":
      return "neutral";
    default:
      return "info";
  }
}

export default function MyLegalOrders() {
  const { currentEmployee, isLoading: empLoading } = useCurrentEmployee();
  const { formatCurrency } = useCurrency();
  const [expanded, setExpanded] = useState<string | null>(null);

  const { data: orders = [], isLoading } = useQuery<LegalOrderRow[]>({
    queryKey: ["me_legal_orders", currentEmployee?.id],
    enabled: !!currentEmployee?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("legal_orders" as any)
        .select(
          "id, organization_id, employee_id, kind_code, case_reference, authority_name, status, priority_class, start_date, end_date, total_owed, total_paid, total_accrued, evidence_requirements, notes",
        )
        .eq("employee_id", currentEmployee!.id)
        .order("priority_class", { ascending: true, nullsFirst: false })
        .order("start_date", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as LegalOrderRow[];
    },
  });

  const totals = useMemo(() => {
    const owed = orders.reduce((s, o) => s + Number(o.total_owed || 0), 0);
    const paid = orders.reduce((s, o) => s + Number(o.total_paid || 0), 0);
    const active = orders.filter((o) => o.status === "active").length;
    return { owed, paid, active, remaining: Math.max(owed - paid, 0) };
  }, [orders]);

  if (empLoading) {
    return (
      <PageBody>
        <Skeleton className="h-40 w-full" />
      </PageBody>
    );
  }
  if (!currentEmployee) {
    return <EmployeeLinkRequired />;
  }

  return (
    <>
      <PageHeader
        title="My Legal Orders"
        description="Court orders, garnishments and tax levies applied to your payroll. Upload supporting documents when your HR team requests them."
        icon={Scale}
      />
      <PageBody>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <Card>
            <CardHeader className="pb-2"><CardDescription>Active orders</CardDescription></CardHeader>
            <CardContent><div className="text-2xl font-semibold">{totals.active}</div></CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardDescription>Total owed</CardDescription></CardHeader>
            <CardContent><div className="text-2xl font-semibold">{formatCurrency(totals.owed)}</div></CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardDescription>Total paid</CardDescription></CardHeader>
            <CardContent><div className="text-2xl font-semibold">{formatCurrency(totals.paid)}</div></CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardDescription>Remaining</CardDescription></CardHeader>
            <CardContent><div className="text-2xl font-semibold">{formatCurrency(totals.remaining)}</div></CardContent>
          </Card>
        </div>

        <Card className="mt-4">
          <CardHeader>
            <CardTitle>Orders on file</CardTitle>
            <CardDescription>Ordered by legal priority. Contact HR for changes.</CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-24 w-full" />
            ) : orders.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No legal orders on file. If you have received a court order or notice from a tax authority, please forward it to your HR team.
              </p>
            ) : (
              <ul className="divide-y rounded-md border">
                {orders.map((o) => {
                  const open = expanded === o.id;
                  return (
                    <li key={o.id} className="px-3 py-3">
                      <button
                        type="button"
                        onClick={() => setExpanded(open ? null : o.id)}
                        className="w-full flex items-start gap-3 text-left"
                      >
                        {open ? <ChevronDown className="h-4 w-4 mt-1" /> : <ChevronRight className="h-4 w-4 mt-1" />}
                        <div className="flex-1 min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium">{o.kind_code.replace(/_/g, " ")}</span>
                            {o.case_reference && (
                              <Badge variant="outline" className="text-[10px]">Case {o.case_reference}</Badge>
                            )}
                            {typeof o.priority_class === "number" && (
                              <Badge variant="outline" className="text-[10px]">Priority {o.priority_class}</Badge>
                            )}
                            <StatusBadge tone={statusTone(o.status)}>{o.status.replace(/_/g, " ")}</StatusBadge>
                          </div>
                          <div className="text-xs text-muted-foreground mt-1">
                            {o.authority_name ?? "Authority pending"}
                            {o.start_date ? ` · from ${o.start_date}` : ""}
                            {o.end_date ? ` · to ${o.end_date}` : ""}
                          </div>
                          <div className="text-xs text-muted-foreground mt-0.5">
                            Owed {formatCurrency(Number(o.total_owed || 0))} · Paid {formatCurrency(Number(o.total_paid || 0))}
                          </div>
                        </div>
                      </button>
                      {open && (
                        <div className="mt-3 pl-7 space-y-3">
                          {o.notes && (
                            <div className="text-xs bg-muted/50 rounded-md px-3 py-2">{o.notes}</div>
                          )}
                          <div>
                            <div className="text-xs font-medium mb-2">Supporting documents</div>
                            <LegalOrderDocuments
                              garnishmentId={o.id}
                              evidenceRequirements={o.evidence_requirements}
                              canWrite
                            />
                          </div>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      </PageBody>
    </>
  );
}