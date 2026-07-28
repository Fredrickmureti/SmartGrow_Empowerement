/**
 * Exceptions Inbox (ADR 0101 — Phase 1.2).
 *
 * Single triage surface for every WMS blocker: receiving discrepancies,
 * QC fails, short-picks, count variances, damaged LPNs, missing bins.
 * Rows are inserted into `wms_exceptions` by RPCs and page code; this
 * page is the resolver UI.
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
import { AlertTriangle, ShieldCheck } from "lucide-react";

type ExceptionRow = {
  id: string;
  warehouse_id: string;
  aggregate: string;
  aggregate_id: string;
  code: string;
  severity: "low" | "medium" | "high" | "critical";
  state: "open" | "in_review" | "resolved" | "dismissed";
  reason: string | null;
  resolution_notes: string | null;
  created_at: string;
  resolved_at: string | null;
  row_version: number;
};

const SEVERITY_TONE = {
  low: "neutral", medium: "info", high: "warning", critical: "danger",
} as const;
const STATE_TONE = {
  open: "warning", in_review: "info", resolved: "success", dismissed: "neutral",
} as const;

export default function ExceptionsInbox() {
  const qc = useQueryClient();
  const { data: warehouses = [] } = useWarehouses();
  const [warehouseId, setWarehouseId] = useState<string>("");
  const [stateFilter, setStateFilter] = useState<string>("open");
  const [active, setActive] = useState<ExceptionRow | null>(null);
  const [notes, setNotes] = useState("");

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
      if (stateFilter !== "all") q = q.eq("state", stateFilter);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as ExceptionRow[];
    },
  });

  const resolve = useMutation({
    mutationFn: async ({ id, action }: { id: string; action: "resolved" | "dismissed" }) => {
      const { error } = await supabase.rpc("wms_resolve_exception" as any, {
        p_exception_id: id,
        p_to_state: action,
        p_notes: notes || null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Exception updated.");
      setActive(null); setNotes("");
      qc.invalidateQueries({ queryKey: ["wms_exceptions"] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Could not update exception."),
  });

  const summary = useMemo(() => {
    const c = { open: 0, in_review: 0, resolved: 0, dismissed: 0 } as Record<string, number>;
    rows.forEach((r) => { c[r.state] = (c[r.state] ?? 0) + 1; });
    return c;
  }, [rows]);

  return (
    <>
      <PageHeader
        title="Exceptions Inbox"
        subtitle="Every blocked task, discrepancy, and QC fail lands here."
        icon={AlertTriangle}
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
                <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="open">Open</SelectItem>
                  <SelectItem value="in_review">In review</SelectItem>
                  <SelectItem value="resolved">Resolved</SelectItem>
                  <SelectItem value="dismissed">Dismissed</SelectItem>
                  <SelectItem value="all">All</SelectItem>
                </SelectContent>
              </Select>
            </div>
          }
        >
          <div className="mb-4 grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
            {(["open", "in_review", "resolved", "dismissed"] as const).map((s) => (
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
                  <TableHead>Aggregate</TableHead>
                  <TableHead>Code</TableHead>
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
                    <TableCell className="text-xs">
                      <div className="font-medium">{r.aggregate}</div>
                      <div className="text-muted-foreground font-mono">{r.aggregate_id.slice(0, 8)}</div>
                    </TableCell>
                    <TableCell className="text-xs font-mono">{r.code}</TableCell>
                    <TableCell><StatusBadge tone={SEVERITY_TONE[r.severity]}>{r.severity}</StatusBadge></TableCell>
                    <TableCell><StatusBadge tone={STATE_TONE[r.state]}>{r.state}</StatusBadge></TableCell>
                    <TableCell className="max-w-md truncate text-xs">{r.reason}</TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={r.state === "resolved" || r.state === "dismissed"}
                        onClick={() => { setActive(r); setNotes(r.resolution_notes ?? ""); }}
                      >
                        Triage
                      </Button>
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
            <DialogTitle>Resolve exception</DialogTitle>
          </DialogHeader>
          {active && (
            <div className="space-y-3 text-sm">
              <div><span className="text-muted-foreground">Code:</span> <span className="font-mono">{active.code}</span></div>
              <div><span className="text-muted-foreground">Aggregate:</span> {active.aggregate} <span className="font-mono">{active.aggregate_id}</span></div>
              <div><span className="text-muted-foreground">Reason:</span> {active.reason ?? "—"}</div>
              <Textarea
                placeholder="Resolution notes (what did you do?)"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={4}
              />
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => active && resolve.mutate({ id: active.id, action: "dismissed" })}
              disabled={resolve.isPending}
            >
              Dismiss
            </Button>
            <Button
              onClick={() => active && resolve.mutate({ id: active.id, action: "resolved" })}
              disabled={resolve.isPending || notes.trim().length === 0}
            >
              Mark resolved
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
