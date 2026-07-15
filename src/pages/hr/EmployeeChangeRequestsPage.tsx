/**
 * EmployeeChangeRequestsPage — HR review queue for employee-submitted
 * profile change requests.
 *
 * Route: /hr/employees/change-requests
 *
 * Reads: employee_profile_change_requests (HR-select RLS admits admins).
 * Writes: review_profile_change_request(id, decision, note) RPC, which
 *   is role-gated in the DB and applies whitelisted diffs to `employees`
 *   on approval.
 *
 * This page is the enterprise-side of the ownership matrix: employees
 * cannot mutate HR-owned fields (legal name, national ID, bank, DOB)
 * without an HR admin approving the change here.
 */
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, ClipboardList, Check, X } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader, PageBody } from "@/design-system";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";

type ChangeRequest = {
  id: string;
  employee_id: string;
  field_key: string;
  old_value: any;
  new_value: any;
  reason: string | null;
  status: "pending" | "approved" | "rejected" | "cancelled";
  requested_by: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  created_at: string;
  employee?: { first_name: string; last_name: string; employee_number: string } | null;
};

const FIELD_LABEL: Record<string, string> = {
  first_name: "Legal first name",
  last_name: "Legal last name",
  national_id: "National ID",
  date_of_birth: "Date of birth",
  gender: "Gender",
  bank_name: "Bank name",
  bank_branch: "Bank branch",
  bank_account_number: "Bank account number",
  bank_code: "Bank code",
};

export default function EmployeeChangeRequestsPage() {
  const qc = useQueryClient();
  const [status, setStatus] = useState<"pending" | "approved" | "rejected" | "cancelled">("pending");

  const { data, isLoading } = useQuery({
    queryKey: ["hr-profile-change-requests", status],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("employee_profile_change_requests" as any)
        .select(`
          id, employee_id, field_key, old_value, new_value, reason, status,
          requested_by, reviewed_by, reviewed_at, review_note, created_at,
          employee:employees!employee_profile_change_requests_employee_id_fkey(first_name,last_name,employee_number)
        `)
        .eq("status", status)
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as unknown as ChangeRequest[];
    },
  });

  const rows = useMemo(() => data ?? [], [data]);

  const decide = async (id: string, decision: "approved" | "rejected", note?: string) => {
    const { error } = await supabase.rpc("review_profile_change_request" as any, {
      p_request_id: id,
      p_decision: decision,
      p_note: note ?? null,
    });
    if (error) { toast.error(error.message); return; }
    toast.success(decision === "approved" ? "Change approved and applied." : "Change rejected.");
    qc.invalidateQueries({ queryKey: ["hr-profile-change-requests"] });
  };

  return (
    <>
      <PageHeader
        title="Profile change requests"
        description="Employee-submitted edits to HR-owned fields. Approving applies the change to the employee record."
      />
      <PageBody>
        <Tabs value={status} onValueChange={(v) => setStatus(v as any)} className="mb-4">
          <TabsList>
            <TabsTrigger value="pending">Pending</TabsTrigger>
            <TabsTrigger value="approved">Approved</TabsTrigger>
            <TabsTrigger value="rejected">Rejected</TabsTrigger>
            <TabsTrigger value="cancelled">Cancelled</TabsTrigger>
          </TabsList>
        </Tabs>

        {isLoading ? (
          <div className="flex items-center justify-center h-64">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : rows.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center text-sm text-muted-foreground">
              <ClipboardList className="h-8 w-8 mx-auto mb-2 opacity-50" />
              No {status} requests.
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {rows.map((r) => (
              <RequestRow key={r.id} req={r} onDecide={decide} />
            ))}
          </div>
        )}
      </PageBody>
    </>
  );
}

function RequestRow({ req, onDecide }: {
  req: ChangeRequest;
  onDecide: (id: string, decision: "approved" | "rejected", note?: string) => Promise<void>;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<null | "approved" | "rejected">(null);
  const oldStr = req.old_value == null ? "—" : typeof req.old_value === "string" ? req.old_value : JSON.stringify(req.old_value);
  const newStr = req.new_value == null ? "—" : typeof req.new_value === "string" ? req.new_value : JSON.stringify(req.new_value);
  const empName = req.employee ? `${req.employee.first_name} ${req.employee.last_name}` : "Employee";

  const act = async (d: "approved" | "rejected") => {
    setBusy(d);
    try { await onDecide(req.id, d, note || undefined); } finally { setBusy(null); }
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="text-base">
              {empName}{" "}
              <span className="font-mono text-xs text-muted-foreground">
                {req.employee?.employee_number}
              </span>
            </CardTitle>
            <CardDescription>
              {FIELD_LABEL[req.field_key] ?? req.field_key} · submitted{" "}
              {new Date(req.created_at).toLocaleString()}
            </CardDescription>
          </div>
          <Badge variant={req.status === "pending" ? "secondary" : "outline"}>{req.status}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <div className="text-xs text-muted-foreground mb-1">Current</div>
            <div className="rounded border bg-muted/30 px-2 py-1">{oldStr}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground mb-1">Proposed</div>
            <div className="rounded border bg-muted/30 px-2 py-1">{newStr}</div>
          </div>
        </div>
        {req.reason && (
          <div className="text-xs text-muted-foreground">Employee reason: {req.reason}</div>
        )}
        {req.status === "pending" && (
          <div className="space-y-2 pt-1">
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Optional note for the employee"
              rows={2}
            />
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" disabled={!!busy} onClick={() => act("rejected")}>
                {busy === "rejected" ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <X className="h-4 w-4 mr-2" />}
                Reject
              </Button>
              <Button size="sm" disabled={!!busy} onClick={() => act("approved")}>
                {busy === "approved" ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Check className="h-4 w-4 mr-2" />}
                Approve
              </Button>
            </div>
          </div>
        )}
        {req.review_note && req.status !== "pending" && (
          <div className="text-xs text-muted-foreground">HR note: {req.review_note}</div>
        )}
      </CardContent>
    </Card>
  );
}
