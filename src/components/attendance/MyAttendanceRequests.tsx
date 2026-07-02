/**
 * MyAttendanceRequests — read-only inbox of the current employee's
 * pending and recently reviewed correction & overtime requests.
 *
 * RLS already restricts these queries to the caller's own rows; the
 * explicit employee_id filter is defense in depth.
 */
import { useQuery } from "@tanstack/react-query";
import { format, formatDistanceToNow } from "date-fns";
import { CheckCircle2, Clock, XCircle } from "lucide-react";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentEmployee } from "@/hooks/useCurrentEmployee";
import { cn } from "@/lib/utils";

interface CorrectionRow {
  id: string;
  attendance_date: string;
  status: string;
  reason: string;
  requested_at: string;
  reviewed_at: string | null;
  review_note: string | null;
}
interface OvertimeRow {
  id: string;
  ot_date: string;
  requested_hours: number;
  status: string;
  reason: string | null;
  created_at: string;
  rejection_reason: string | null;
}

const STATUS_BADGE: Record<string, string> = {
  pending: "bg-amber-100 text-amber-800 border-amber-200",
  approved: "bg-emerald-100 text-emerald-800 border-emerald-200",
  rejected: "bg-rose-100 text-rose-800 border-rose-200",
  cancelled: "bg-muted text-muted-foreground",
};

const STATUS_ICON: Record<string, any> = {
  pending: Clock,
  approved: CheckCircle2,
  rejected: XCircle,
};

export function MyAttendanceRequests() {
  const { currentEmployee } = useCurrentEmployee();

  const corrections = useQuery({
    queryKey: ["my-corrections", currentEmployee?.id],
    enabled: !!currentEmployee?.id,
    queryFn: async (): Promise<CorrectionRow[]> => {
      const { data, error } = await supabase
        .from("attendance_corrections" as any)
        .select("id, attendance_date, status, reason, requested_at, reviewed_at, review_note")
        .eq("employee_id", currentEmployee!.id)
        .order("requested_at", { ascending: false })
        .limit(20);
      if (error) throw error;
      return (data ?? []) as unknown as CorrectionRow[];
    },
  });

  const overtime = useQuery({
    queryKey: ["my-overtime", currentEmployee?.id],
    enabled: !!currentEmployee?.id,
    queryFn: async (): Promise<OvertimeRow[]> => {
      const { data, error } = await supabase
        .from("overtime_requests" as any)
        .select("id, ot_date, requested_hours, status, reason, created_at, rejection_reason")
        .eq("employee_id", currentEmployee!.id)
        .order("created_at", { ascending: false })
        .limit(20);
      if (error) throw error;
      return (data ?? []) as unknown as OvertimeRow[];
    },
  });

  const corrPending = (corrections.data ?? []).filter((c) => c.status === "pending").length;
  const otPending = (overtime.data ?? []).filter((o) => o.status === "pending").length;
  const totalPending = corrPending + otPending;

  return (
    <Accordion type="single" collapsible defaultValue={totalPending > 0 ? "requests" : undefined}>
      <AccordionItem value="requests">
        <AccordionTrigger className="text-sm">
          <span className="flex items-center gap-2">
            My requests
            {totalPending > 0 && (
              <Badge variant="destructive" className="h-5 px-1.5 text-[10px]">
                {totalPending} pending
              </Badge>
            )}
          </span>
        </AccordionTrigger>
        <AccordionContent>
          <div className="grid gap-4 md:grid-cols-2">
            <RequestList
              title="Time corrections"
              empty="You haven't requested any corrections."
              rows={(corrections.data ?? []).map((c) => ({
                id: c.id,
                date: c.attendance_date,
                status: c.status,
                primary: c.reason,
                secondary: c.review_note ?? null,
                when: c.requested_at,
              }))}
            />
            <RequestList
              title="Overtime"
              empty="You haven't requested any overtime."
              rows={(overtime.data ?? []).map((o) => ({
                id: o.id,
                date: o.ot_date,
                status: o.status,
                primary: `${Number(o.requested_hours).toFixed(2)}h${o.reason ? ` · ${o.reason}` : ""}`,
                secondary: o.rejection_reason ?? null,
                when: o.created_at,
              }))}
            />
          </div>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}

function RequestList({
  title,
  empty,
  rows,
}: {
  title: string;
  empty: string;
  rows: { id: string; date: string; status: string; primary: string; secondary: string | null; when: string }[];
}) {
  return (
    <div>
      <p className="text-xs font-medium text-muted-foreground mb-2">{title}</p>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground italic">{empty}</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => {
            const Icon = STATUS_ICON[r.status] ?? Clock;
            return (
              <li key={r.id} className="rounded-md border p-2.5 text-sm">
                <div className="flex items-center justify-between gap-2 mb-1">
                  <span className="font-medium">{format(new Date(r.date), "MMM d, yyyy")}</span>
                  <Badge variant="outline" className={cn("h-5 px-1.5 text-[10px] gap-1", STATUS_BADGE[r.status])}>
                    <Icon className="h-3 w-3" />
                    {r.status}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground line-clamp-2">{r.primary}</p>
                {r.secondary && (
                  <p className="text-[11px] mt-1 italic text-muted-foreground">"{r.secondary}"</p>
                )}
                <p className="text-[10px] text-muted-foreground mt-1">
                  {formatDistanceToNow(new Date(r.when), { addSuffix: true })}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
