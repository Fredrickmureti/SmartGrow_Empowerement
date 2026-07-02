/**
 * LivePresenceCard — realtime "Who's clocked in right now".
 *
 * Subscribes to Postgres changes on `attendance` (INSERT/UPDATE/DELETE)
 * scoped to the active org and refetches the open-session roster on any
 * change. Shows employee, branch, clock-in time, source, and an indicator
 * for employees currently on break.
 */
import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranches } from "@/hooks/useBranches";
import { applyBranchFilter } from "@/lib/branchScope";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Building2, Coffee, CornerDownRight, Loader2, MapPin, Radio } from "lucide-react";
import { format, formatDistanceToNowStrict } from "date-fns";
import { cn } from "@/lib/utils";

interface OpenSession {
  id: string;
  employee_id: string;
  clock_in: string;
  source: string | null;
  branch_id: string | null;
  employee: { first_name: string; last_name: string; employee_number: string | null } | null;
  branch: { name: string } | null;
  open_break: { id: string; break_type: string | null; started_at: string } | null;
}

export function LivePresenceCard() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranches();
  const qc = useQueryClient();

  const queryKey = ["attendance-live-presence", currentOrg?.id, currentBusiness?.id, currentBranch?.id];

  const { data, isLoading } = useQuery({
    queryKey,
    enabled: !!currentOrg?.id,
    refetchInterval: 30_000,
    queryFn: async (): Promise<OpenSession[]> => {
      if (!currentOrg?.id) return [];
      let q = supabase
        .from("attendance" as any)
        .select(
          "id, employee_id, clock_in, source, branch_id, employee:employees(first_name,last_name,employee_number), branch:branches(name)",
        )
        .eq("organization_id", currentOrg.id)
        .is("clock_out", null)
        .order("clock_in", { ascending: false });
      if (currentBusiness?.id) q = q.eq("business_id", currentBusiness.id);
      // Odoo parity: presence is company-wide. Branch is a soft scope —
      // include rows whose branch_id matches OR is NULL (legacy/shared).
      q = applyBranchFilter(q, currentBranch?.id);
      const { data: rows, error } = await q;
      if (error) throw error;
      const ids = (rows ?? []).map((r: any) => r.id);
      if (ids.length === 0) return [];
      const { data: breaks } = await supabase
        .from("attendance_breaks" as any)
        .select("id, attendance_id, break_type, started_at")
        .in("attendance_id", ids)
        .is("ended_at", null);
      const breakByAttendance = new Map<string, any>();
      (breaks ?? []).forEach((b: any) => breakByAttendance.set(b.attendance_id, b));
      return (rows ?? []).map((r: any) => ({
        ...r,
        open_break: breakByAttendance.get(r.id) ?? null,
      })) as OpenSession[];
    },
  });

  useEffect(() => {
    if (!currentOrg?.id) return;
    const channel = supabase
      .channel(`presence-${currentOrg.id}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "attendance", filter: `organization_id=eq.${currentOrg.id}` },
        () => qc.invalidateQueries({ queryKey }),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "attendance_breaks" },
        () => qc.invalidateQueries({ queryKey }),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentOrg?.id, currentBusiness?.id, currentBranch?.id]);

  const rows = data ?? [];
  const onBreak = rows.filter((r) => r.open_break).length;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 flex-wrap">
        <div className="flex flex-col gap-1">
          <CardTitle className="text-base flex items-center gap-2">
            <Radio className="h-4 w-4 text-emerald-500 animate-pulse" />
            Live presence
          </CardTitle>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {currentBusiness?.name && (
              <span className="inline-flex items-center gap-1">
                <Building2 className="h-3 w-3" /> {currentBusiness.name}
              </span>
            )}
            <span className="inline-flex items-center gap-1">
              <MapPin className="h-3 w-3" />
              {currentBranch?.name
                ? `${currentBranch.name} + company-wide`
                : `All branches${currentBusiness?.name ? "" : " (workspace)"}`}
            </span>
          </div>
        </div>
        <div className="flex gap-2">
          <Badge variant="secondary">{rows.length} clocked in</Badge>
          {onBreak > 0 && <Badge variant="outline">{onBreak} on break</Badge>}
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No employees currently clocked in{currentBusiness?.name ? ` for ${currentBusiness.name}` : ""}.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Employee</TableHead>
                <TableHead>Branch</TableHead>
                <TableHead>Clocked in</TableHead>
                <TableHead>Elapsed</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => {
                const matchesActiveBranch =
                  !!currentBranch?.id && r.branch_id === currentBranch.id;
                const startedAt = new Date(r.clock_in);
                const jumpToRoster = () => {
                  const el = document.getElementById(`roster-row-${r.employee_id}`);
                  if (el) {
                    el.scrollIntoView({ behavior: "smooth", block: "center" });
                    el.classList.add("ring-2", "ring-primary");
                    setTimeout(() => el.classList.remove("ring-2", "ring-primary"), 2000);
                  }
                };
                return (
                  <TableRow
                    key={r.id}
                    className={cn(matchesActiveBranch && "bg-accent/40")}
                  >
                    <TableCell>
                      {r.employee
                        ? `${r.employee.first_name} ${r.employee.last_name}${r.employee.employee_number ? ` (${r.employee.employee_number})` : ""}`
                        : r.employee_id.slice(0, 8)}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {r.branch?.name ?? "—"}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      since {format(startedAt, "HH:mm")}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground tabular-nums">
                      {formatDistanceToNowStrict(startedAt)}
                    </TableCell>
                    <TableCell className="text-xs">{r.source ?? "-"}</TableCell>
                    <TableCell>
                      {r.open_break ? (
                        <Badge variant="outline" className="gap-1">
                          <Coffee className="h-3 w-3" />
                          On break{r.open_break.break_type ? ` (${r.open_break.break_type})` : ""}
                        </Badge>
                      ) : (
                        <Badge variant="secondary">Working</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 gap-1 text-xs"
                        onClick={jumpToRoster}
                        title="Jump to roster row"
                      >
                        <CornerDownRight className="h-3 w-3" />
                        Jump
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
