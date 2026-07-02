/**
 * MyRequestDecisions — surfaces recent (last 7 days) decisions on the
 * current employee's correction and overtime requests so they don't have
 * to dig through History → Requests to learn HR's verdict.
 *
 * Each pill is dismissible — dismissal is tracked in localStorage by id,
 * so once acknowledged it stays gone across sessions.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { CheckCircle2, XCircle, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentEmployee } from "@/hooks/useCurrentEmployee";
import { cn } from "@/lib/utils";

interface Decision {
  id: string;
  kind: "correction" | "overtime";
  status: "approved" | "rejected";
  reviewed_at: string;
  note: string | null;
}

const STORAGE_KEY = "me.attendance.decisions.dismissed";

function loadDismissed(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function persistDismissed(set: Set<string>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(set)));
  } catch {
    /* ignore */
  }
}

export function MyRequestDecisions() {
  const { currentEmployee } = useCurrentEmployee();
  const [dismissed, setDismissed] = useState<Set<string>>(loadDismissed);

  const sevenDaysAgo = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    return d.toISOString();
  }, []);

  const { data: decisions = [] } = useQuery<Decision[]>({
    queryKey: ["my-request-decisions", currentEmployee?.id, sevenDaysAgo],
    enabled: !!currentEmployee?.id,
    queryFn: async () => {
      const empId = currentEmployee!.id;
      const [corrRes, otRes] = await Promise.all([
        supabase
          .from("attendance_corrections")
          .select("id, status, reviewed_at, review_note")
          .eq("employee_id", empId)
          .in("status", ["approved", "rejected"])
          .gte("reviewed_at", sevenDaysAgo)
          .order("reviewed_at", { ascending: false }),
        supabase
          .from("overtime_requests" as any)
          .select("id, status, approved_at, rejection_reason")
          .eq("employee_id", empId)
          .in("status", ["approved", "rejected"])
          .gte("approved_at", sevenDaysAgo)
          .order("approved_at", { ascending: false }),
      ]);

      const corr = ((corrRes.data ?? []) as any[]).map(
        (r): Decision => ({
          id: `correction:${r.id}`,
          kind: "correction",
          status: r.status,
          reviewed_at: r.reviewed_at,
          note: r.review_note,
        }),
      );
      const ot = ((otRes.data ?? []) as any[])
        .filter((r) => r.approved_at) // only when reviewed
        .map(
          (r): Decision => ({
            id: `overtime:${r.id}`,
            kind: "overtime",
            status: r.status,
            reviewed_at: r.approved_at,
            note: r.rejection_reason,
          }),
        );
      return [...corr, ...ot].sort(
        (a, b) => new Date(b.reviewed_at).getTime() - new Date(a.reviewed_at).getTime(),
      );
    },
  });

  const visible = decisions.filter((d) => !dismissed.has(d.id));
  if (visible.length === 0) return null;

  const dismiss = (id: string) => {
    const next = new Set(dismissed);
    next.add(id);
    setDismissed(next);
    persistDismissed(next);
  };

  return (
    <div className="space-y-1.5">
      {visible.map((d) => {
        const approved = d.status === "approved";
        const Icon = approved ? CheckCircle2 : XCircle;
        const label =
          d.kind === "correction"
            ? approved
              ? "Correction approved"
              : "Correction rejected"
            : approved
              ? "Overtime approved"
              : "Overtime rejected";
        return (
          <div
            key={d.id}
            className={cn(
              "flex items-center justify-between gap-2 rounded-md border px-3 py-2",
              approved
                ? "bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-900/50"
                : "bg-rose-50 dark:bg-rose-950/30 border-rose-200 dark:border-rose-900/50",
            )}
          >
            <div className="flex items-center gap-2 min-w-0 text-sm">
              <Icon
                className={cn(
                  "h-4 w-4 shrink-0",
                  approved ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400",
                )}
              />
              <span className="font-medium">{label}</span>
              <Badge variant="outline" className="text-[10px]">
                {formatDistanceToNow(new Date(d.reviewed_at), { addSuffix: true })}
              </Badge>
              {d.note && (
                <span className="text-xs text-muted-foreground truncate">— {d.note}</span>
              )}
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <Button asChild size="sm" variant="ghost" className="h-7 text-xs">
                <Link to="/me/attendance?tab=history">View</Link>
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7"
                onClick={() => dismiss(d.id)}
                aria-label="Dismiss"
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
