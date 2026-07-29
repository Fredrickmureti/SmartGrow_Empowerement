/**
 * Exceptions Inbox (ADR 0101 — Phase 1.4).
 *
 * Single triage surface for every WMS blocker: receiving discrepancies,
 * QC fails, short-picks, count variances, damaged LPNs, missing bins,
 * stale tasks.
 *
 * Rows are inserted by `wms_raise_exception` (called from cancel flows,
 * discrepancy handlers, count post) and moved through their FSM via
 * `wms_resolve_exception` with row_version optimistic locking.
 */
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import {
  PageHeader, PageBody, Section, LoadingState, EmptyState, StatusBadge,
} from "@/design-system";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { useWarehouses } from "@/hooks/useWarehouses";
import { ShieldCheck } from "lucide-react";

type ExceptionState = "open" | "acknowledged" | "investigating" | "resolved" | "wont_fix" | "escalated";

type ExceptionRow = {
  id: string;
  warehouse_id: string;
  kind: string;
  aggregate_type: string | null;
  aggregate_id: string | null;
  task_id: string | null;
  lpn_id: string | null;
  severity: number;
  state: ExceptionState;
  reason: string | null;
  details: Record<string, unknown> | null;
  resolution: string | null;
  created_at: string;
  resolved_at: string | null;
  row_version: number;
};

const STATE_TONE: Record<ExceptionState, "info" | "warning" | "success" | "neutral" | "danger"> = {
  open: "warning",
  acknowledged: "info",
  investigating: "info",
  escalated: "danger",
  resolved: "success",
  wont_fix: "neutral",
};

const severityTone = (n: number) =>
  n >= 4 ? "danger" : n === 3 ? "warning" : n === 2 ? "info" : "neutral";
const severityLabel = (n: number) =>
  ({ 1: "low", 2: "medium", 3: "high", 4: "critical", 5: "critical" } as Record<number, string>)[n] ?? "medium";

const OPEN_STATES: ExceptionState[] = ["open", "acknowledged", "investigating", "escalated"];

export default function ExceptionsInbox() {
  const qc = useQueryClient();
  const { warehouses } = useWarehouses();
  const [warehouseId, setWarehouseId] = useState<string>("");
  const [stateFilter, setStateFilter] = useState<string>("open_all");
  const [active, setActive] = useState<ExceptionRow | null>(null);
  const [resolution, setResolution] = useState("");

  const effectiveWh = warehouseId || warehouses[0]?.id || "";

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["wms_exceptions", effectiveWh, stateFilter],
    enabled: !!effectiveWh,
    queryFn: async () => {
      let q = supabase
        .from("wms_exceptions" as any)
        .select("*")
        .eq("warehouse_id", effectiveWh)
        .order("created_at", { ascending: false })
        .limit(200);
      if (stateFilter === "open_all") q = q.in("state", OPEN_STATES);
      else if (stateFilter !== "all") q = q.eq("state", stateFilter);
      const { data, error } = await q;
      if (error) throw error;
      return ((data ?? []) as unknown) as ExceptionRow[];
    },
  });

  const transition = useMutation({
    mutationFn: async (input: { id: string; to: ExceptionState; rowVersion: number; resolution?: string }) => {
      const { error } = await supabase.rpc("wms_resolve_exception" as any, {
        p_exception_id: input.id,
        p_to_state: input.to,
        p_row_version: input.rowVersion,
        p_resolution: input.resolution ?? null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Exception updated");
      setActive(null); setResolution("");
      qc.invalidateQueries({ queryKey: ["wms_exceptions"] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Could not update exception"),
  });

  const summary = useMemo(() => {
    const c: Record<string, number> = {
      open: 0, acknowledged: 0, investigating: 0, escalated: 0, resolved: 0, wont_fix: 0,
    };
    rows.forEach((r) => { c[r.state] = (c[r.state] ?? 0) + 1; });
    return c;
  }, [rows]);

  return (
    <>
      <PageHeader
        title="Exceptions Inbox"
        description="Every blocked task, discrepancy, and QC fail lands here. Triage moves the row through open → acknowledged → investigating → resolved."
      />
      <PageBody>
        <Section
          title="Queue"
          actions={
            <div className="flex gap-2">
              <Select value={effectiveWh} onValueChange={setWarehouseId}>
                <SelectTrigger className="w-56"><SelectValue placeholder="Warehouse" /></SelectTrigger>
                <SelectContent>
                  {warehouses.map((w) => (
                    <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={stateFilter} onValueChange={setStateFilter}>
                <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="open_all">Open (default)</SelectItem>
                  <SelectItem value="open">Open</SelectItem>
                  <SelectItem value="acknowledged">Acknowledged</SelectItem>
                  <SelectItem value="investigating">Investigating</SelectItem>
                  <SelectItem value="escalated">Escalated</SelectItem>
                  <SelectItem value="resolved">Resolved</SelectItem>
                  <SelectItem value="wont_fix">Won't fix</SelectItem>
                  <SelectItem value="all">All</SelectItem>
                </SelectContent>
              </Select>
            </div>
          }
        >
          <div className="mb-4 grid grid-cols-2 md:grid-cols-6 gap-3 text-sm">
            {(["open", "acknowledged", "investigating", "escalated", "resolved", "wont_fix"] as const).map((s) => (
              <div key={s} className="rounded-md border border-border bg-card p-3">
                <div className="text-muted-foreground capitalize">{s.replace("_", " ")}</div>
                <div className="text-2xl font-semibold">{summary[s] ?? 0}</div>
              </div>
            ))}
          </div>

          {isLoading ? (
            <LoadingState />
          ) : rows.length === 0 ? (
            <EmptyState icon={ShieldCheck} title="Nothing to triage" description="No exceptions match your filter." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Aggregate</TableHead>
                  <TableHead>Severity</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="whitespace-nowrap text-xs">
                      {new Date(r.created_at).toLocaleString()}
                    </TableCell>
                    <TableCell className="text-xs font-medium">{r.kind}</TableCell>
                    <TableCell className="text-xs">
                      <div>{r.aggregate_type ?? "—"}</div>
                      {r.aggregate_id && <div className="text-muted-foreground font-mono">{r.aggregate_id.slice(0, 8)}</div>}
                    </TableCell>
                    <TableCell><StatusBadge tone={severityTone(r.severity)}>{severityLabel(r.severity)}</StatusBadge></TableCell>
                    <TableCell><StatusBadge tone={STATE_TONE[r.state]}>{r.state.replace("_", " ")}</StatusBadge></TableCell>
                    <TableCell className="max-w-md truncate text-xs">{r.reason}</TableCell>
                    <TableCell className="text-right space-x-1">
                      {r.state === "open" && (
                        <Button size="sm" variant="outline" onClick={() => transition.mutate({ id: r.id, to: "acknowledged", rowVersion: r.row_version })}>
                          Ack
                        </Button>
                      )}
                      {r.state !== "resolved" && r.state !== "wont_fix" && (
                        <Button size="sm" onClick={() => { setActive(r); setResolution(r.resolution ?? ""); }}>
                          Triage
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Section>
      </PageBody>

      <Dialog open={!!active} onOpenChange={(o) => !o && setActive(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Triage exception</DialogTitle>
          </DialogHeader>
          {active && (
            <div className="space-y-3 text-sm">
              <div><span className="text-muted-foreground">Kind:</span> {active.kind}</div>
              <div><span className="text-muted-foreground">Aggregate:</span> {active.aggregate_type ?? "—"} <span className="font-mono">{active.aggregate_id ?? ""}</span></div>
              <div><span className="text-muted-foreground">Reason:</span> {active.reason ?? "—"}</div>
              <Textarea
                placeholder="Resolution notes (what did you do?)"
                value={resolution}
                onChange={(e) => setResolution(e.target.value)}
                rows={4}
              />
            </div>
          )}
          <DialogFooter className="flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() => active && transition.mutate({ id: active.id, to: "investigating", rowVersion: active.row_version, resolution })}
              disabled={transition.isPending}
            >
              Investigating
            </Button>
            <Button
              variant="outline"
              onClick={() => active && transition.mutate({ id: active.id, to: "escalated", rowVersion: active.row_version, resolution })}
              disabled={transition.isPending}
            >
              Escalate
            </Button>
            <Button
              variant="outline"
              onClick={() => active && transition.mutate({ id: active.id, to: "wont_fix", rowVersion: active.row_version, resolution })}
              disabled={transition.isPending}
            >
              Won't fix
            </Button>
            <Button
              onClick={() => active && transition.mutate({ id: active.id, to: "resolved", rowVersion: active.row_version, resolution })}
              disabled={transition.isPending || resolution.trim().length === 0}
            >
              Resolve
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
