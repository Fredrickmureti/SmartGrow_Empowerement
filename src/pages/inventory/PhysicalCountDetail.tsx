/**
 * Physical Count Detail Workspace
 *
 * Line-level enterprise view over a single physical_counts aggregate.
 * All actions call D2/D4 lifecycle RPCs — no client-side ledger writes.
 */

import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "sonner";
import { ArrowRight, Loader2, RotateCcw, Undo2 } from "lucide-react";
import { normalizeError } from "@/services/resilience";
import { RecordHeader, ActionBar } from "@/design-system";
import { RefreshButton } from "@/components/ui/RefreshButton";

type CountState =
  | "draft" | "counting" | "counted" | "in_review"
  | "approved" | "posted" | "cancelled" | "superseded";

interface CountHeader {
  id: string;
  count_number: string;
  warehouse_id: string;
  count_type: string;
  state: CountState;
  tolerance_pct: number | null;
  tolerance_value: number | null;
  frozen_at: string | null;
  frozen_by: string | null;
  submitted_by: string | null;
  approved_by: string | null;
  created_by: string | null;
  posted_at: string | null;
  posted_adjustment_ids: string[] | null;
  posted_journal_entry_id: string | null;
  cancellation_reason: string | null;
  notes: string | null;
  warehouses?: { name: string } | null;
}

interface CountLine {
  id: string;
  product_id: string;
  system_qty_at_freeze: number;
  freeze_reconciliation_qty: number;
  counted_qty: number | null;
  recount_qty: number | null;
  variance_qty: number;
  variance_value: number | null;
  unit_cost_snapshot: number | null;
  cost_source: string | null;
  status: string;
  products?: { name: string; sku: string | null } | null;
}

interface CountEvent {
  id: string;
  event_type: string;
  actor_id: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}

const STATE_STYLES: Record<CountState, string> = {
  draft: "bg-muted text-muted-foreground",
  counting: "bg-blue-100 text-blue-800",
  counted: "bg-indigo-100 text-indigo-800",
  in_review: "bg-amber-100 text-amber-800",
  approved: "bg-emerald-100 text-emerald-800",
  posted: "bg-green-100 text-green-800",
  cancelled: "bg-red-100 text-red-800",
  superseded: "bg-gray-100 text-gray-800",
};

const money = (n: number | null | undefined) =>
  (n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function PhysicalCountDetail() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const headerQ = useQuery({
    queryKey: ["physical-count-detail", id],
    enabled: !!id,
    queryFn: async (): Promise<CountHeader> => {
      const { data, error } = await supabase
        .from("physical_counts")
        .select("id, count_number, warehouse_id, count_type, state, tolerance_pct, tolerance_value, frozen_at, frozen_by, submitted_by, approved_by, created_by, posted_at, posted_adjustment_ids, posted_journal_entry_id, cancellation_reason, notes, warehouses:warehouse_id(name)")
        .eq("id", id!)
        .single();
      if (error) throw error;
      return data as unknown as CountHeader;
    },
  });

  const linesQ = useQuery({
    queryKey: ["physical-count-lines", id],
    enabled: !!id,
    queryFn: async (): Promise<CountLine[]> => {
      const { data, error } = await supabase
        .from("physical_count_lines")
        .select("id, product_id, system_qty_at_freeze, freeze_reconciliation_qty, counted_qty, recount_qty, variance_qty, variance_value, unit_cost_snapshot, cost_source, status, products:product_id(name, sku)")
        .eq("count_id", id!)
        .order("status", { ascending: false })
        .limit(2000);
      if (error) throw error;
      return (data ?? []) as unknown as CountLine[];
    },
  });

  const eventsQ = useQuery({
    queryKey: ["physical-count-events", id],
    enabled: !!id,
    queryFn: async (): Promise<CountEvent[]> => {
      const { data, error } = await supabase
        .from("physical_count_events")
        .select("id, event_type, actor_id, payload, created_at")
        .eq("count_id", id!)
        .order("created_at", { ascending: false })
        .limit(500);
      if (error) throw error;
      return (data ?? []) as unknown as CountEvent[];
    },
  });

  const header = headerQ.data;
  const lines = linesQ.data ?? [];
  const events = eventsQ.data ?? [];

  const jePreview = useMemo(() => {
    let surplus = 0, shrinkage = 0;
    const varianceLines = lines.filter((l) => l.counted_qty !== null && l.variance_qty !== 0);
    for (const l of varianceLines) {
      const val = (l.variance_qty || 0) * (l.unit_cost_snapshot || 0);
      if (val > 0) surplus += val;
      else shrinkage += Math.abs(val);
    }
    return { surplus, shrinkage, net: surplus - shrinkage, lineCount: varianceLines.length };
  }, [lines]);

  const runRpc = async (
    action: "freeze" | "submit" | "approve" | "post" | "cancel" | "supersede" | "request_recount",
    extra?: Record<string, unknown>,
  ) => {
    if (!user?.id || !id) return;
    setBusy(true);
    try {
      const rpcName = {
        freeze: "physical_count_freeze",
        submit: "physical_count_submit",
        approve: "physical_count_approve",
        post: "physical_count_post",
        cancel: "physical_count_cancel",
        supersede: "physical_count_supersede",
        request_recount: "physical_count_request_recount",
      }[action];

      const args: Record<string, unknown> = { p_user_id: user.id, ...extra };
      if (action === "supersede") args.p_source_count_id = id;
      else args.p_count_id = id;
      if (action === "approve" && !("p_allow_self" in args)) args.p_allow_self = false;

      const { data, error } = await (supabase.rpc as unknown as (
        n: string, a: Record<string, unknown>,
      ) => Promise<{ data: unknown; error: { message: string } | null }>)(rpcName, args);
      if (error) throw error;
      const res = data as { success?: boolean; error?: string } | null;
      if (res && res.success === false) throw new Error(res.error || `${action} failed`);
      toast.success(`${action.replace("_", " ")} succeeded`);
      qc.invalidateQueries({ queryKey: ["physical-count-detail", id] });
      qc.invalidateQueries({ queryKey: ["physical-count-lines", id] });
      qc.invalidateQueries({ queryKey: ["physical-count-events", id] });
      qc.invalidateQueries({ queryKey: ["physical-counts-workspace"] });
      setSelected(new Set());
    } catch (err: unknown) {
      toast.error(normalizeError(err).message);
    } finally {
      setBusy(false);
    }
  };

  if (headerQ.isLoading) {
    return <div className="p-10 text-center"><Loader2 className="mx-auto h-6 w-6 animate-spin" /></div>;
  }
  if (!header) {
    return <div className="p-10 text-center text-muted-foreground">Count not found.</div>;
  }

  const toggle = (lineId: string) => {
    const next = new Set(selected);
    next.has(lineId) ? next.delete(lineId) : next.add(lineId);
    setSelected(next);
  };

  return (
    <div className="space-y-6 p-4 md:p-6">
      <RecordHeader
        eyebrow={<Link to="/inventory/physical-counts" className="hover:underline">Physical Counts</Link>}
        title={<span className="font-mono">{header.count_number}</span>}
        meta={
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Badge className={STATE_STYLES[header.state]}>{header.state.replace("_", " ")}</Badge>
            <span>·</span>
            <span>{header.warehouses?.name ?? "—"}</span>
            <span>·</span>
            <span className="capitalize">{header.count_type}</span>
            {header.tolerance_pct != null && <><span>·</span><span>tol {header.tolerance_pct}%</span></>}
            {header.tolerance_value != null && <><span>·</span><span>tol ${money(header.tolerance_value)}</span></>}
          </div>
        }
        actions={
          <ActionBar>
            <RefreshButton queryKeyPrefixes={[["physical-count-detail", id] as const, ["physical-count-lines", id] as const]} tooltip="Refresh" />
            {header.state === "draft" && (
              <Button size="sm" disabled={busy} onClick={() => runRpc("freeze")}>Freeze</Button>
            )}
            {header.state === "counting" && (
              <Button size="sm" disabled={busy} onClick={() => runRpc("submit")}>Submit for review</Button>
            )}
            {header.state === "in_review" && selected.size > 0 && (
              <Button size="sm" variant="outline" disabled={busy}
                      onClick={() => runRpc("request_recount", { p_line_ids: Array.from(selected) })}>
                <RotateCcw className="mr-1 h-3 w-3" /> Recount {selected.size}
              </Button>
            )}
            {header.state === "in_review" && (
              <Button size="sm" disabled={busy} onClick={() => runRpc("approve")}>Approve</Button>
            )}
            {header.state === "approved" && (
              <Button size="sm" disabled={busy} onClick={() => runRpc("post")}>Post to ledger</Button>
            )}
            {["draft", "counting", "in_review", "approved"].includes(header.state) && (
              <Button size="sm" variant="destructive" disabled={busy}
                      onClick={() => runRpc("cancel", { p_reason: "Cancelled from detail workspace" })}>
                Cancel
              </Button>
            )}
            {header.state === "posted" && (
              <Button size="sm" variant="destructive" disabled={busy}
                      onClick={() => {
                        const reason = window.prompt("Reason for reversal?", "Reversal");
                        if (reason) runRpc("supersede", { p_reason: reason });
                      }}>
                <Undo2 className="mr-1 h-3 w-3" /> Reverse
              </Button>
            )}
          </ActionBar>
        }
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Card><CardHeader className="pb-2"><CardTitle className="text-xs text-muted-foreground">Lines</CardTitle></CardHeader>
          <CardContent><div className="text-2xl font-bold">{lines.length}</div></CardContent></Card>
        <Card><CardHeader className="pb-2"><CardTitle className="text-xs text-muted-foreground">Variance lines</CardTitle></CardHeader>
          <CardContent><div className="text-2xl font-bold text-amber-600">
            {lines.filter((l) => l.counted_qty !== null && l.variance_qty !== 0).length}
          </div></CardContent></Card>
        <Card><CardHeader className="pb-2"><CardTitle className="text-xs text-muted-foreground">Surplus value</CardTitle></CardHeader>
          <CardContent><div className="text-2xl font-bold text-emerald-600">${money(jePreview.surplus)}</div></CardContent></Card>
        <Card><CardHeader className="pb-2"><CardTitle className="text-xs text-muted-foreground">Shrinkage value</CardTitle></CardHeader>
          <CardContent><div className="text-2xl font-bold text-red-600">${money(jePreview.shrinkage)}</div></CardContent></Card>
      </div>

      <Tabs defaultValue="lines">
        <TabsList>
          <TabsTrigger value="lines">Lines ({lines.length})</TabsTrigger>
          <TabsTrigger value="je">JE preview</TabsTrigger>
          <TabsTrigger value="audit">Audit ({events.length})</TabsTrigger>
          <TabsTrigger value="drill">Drill-down</TabsTrigger>
        </TabsList>

        <TabsContent value="lines">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Count lines</CardTitle>
              <CardDescription>
                Variance = counted − (system + freeze-window reconciliation). Select rows to request a recount while in review.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8"></TableHead>
                    <TableHead>Product</TableHead>
                    <TableHead className="text-right">System</TableHead>
                    <TableHead className="text-right">Recon</TableHead>
                    <TableHead className="text-right">Counted</TableHead>
                    <TableHead className="text-right">Variance</TableHead>
                    <TableHead className="text-right">Unit cost</TableHead>
                    <TableHead className="text-right">Impact</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {lines.map((l) => {
                    const impact = (l.variance_qty || 0) * (l.unit_cost_snapshot || 0);
                    const canSelect = header.state === "in_review";
                    return (
                      <TableRow key={l.id} className={l.variance_qty !== 0 ? "" : "opacity-60"}>
                        <TableCell>
                          <Checkbox checked={selected.has(l.id)} disabled={!canSelect}
                                    onCheckedChange={() => toggle(l.id)} />
                        </TableCell>
                        <TableCell>
                          <div className="font-medium">{l.products?.name ?? l.product_id}</div>
                          {l.products?.sku && <div className="text-xs text-muted-foreground">{l.products.sku}</div>}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{money(l.system_qty_at_freeze)}</TableCell>
                        <TableCell className="text-right tabular-nums text-xs text-muted-foreground">{money(l.freeze_reconciliation_qty)}</TableCell>
                        <TableCell className="text-right tabular-nums">{l.counted_qty == null ? "—" : money(l.counted_qty)}</TableCell>
                        <TableCell className={`text-right tabular-nums font-semibold ${l.variance_qty > 0 ? "text-emerald-600" : l.variance_qty < 0 ? "text-red-600" : ""}`}>
                          {money(l.variance_qty)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">${money(l.unit_cost_snapshot)}</TableCell>
                        <TableCell className={`text-right tabular-nums ${impact > 0 ? "text-emerald-600" : impact < 0 ? "text-red-600" : ""}`}>
                          ${money(impact)}
                        </TableCell>
                        <TableCell><Badge variant="outline" className="capitalize">{l.status.replace("_", " ")}</Badge></TableCell>
                      </TableRow>
                    );
                  })}
                  {lines.length === 0 && (
                    <TableRow><TableCell colSpan={9} className="p-8 text-center text-sm text-muted-foreground">
                      No lines yet. Freeze the count to snapshot warehouse stock.
                    </TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="je">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Journal entry preview</CardTitle>
              <CardDescription>
                Computed live from unit-cost snapshots. The actual posting resolves accounts via the ledger contract and enforces open-fiscal-period checks.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader><TableRow>
                  <TableHead>Account</TableHead>
                  <TableHead className="text-right">Debit</TableHead>
                  <TableHead className="text-right">Credit</TableHead>
                  <TableHead>Description</TableHead>
                </TableRow></TableHeader>
                <TableBody>
                  {jePreview.surplus > 0 && (
                    <>
                      <TableRow>
                        <TableCell>Inventory</TableCell>
                        <TableCell className="text-right tabular-nums">${money(jePreview.surplus)}</TableCell>
                        <TableCell className="text-right">—</TableCell>
                        <TableCell className="text-xs text-muted-foreground">Physical count — surplus</TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell>Inventory adjustment</TableCell>
                        <TableCell className="text-right">—</TableCell>
                        <TableCell className="text-right tabular-nums">${money(jePreview.surplus)}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">Surplus offset</TableCell>
                      </TableRow>
                    </>
                  )}
                  {jePreview.shrinkage > 0 && (
                    <>
                      <TableRow>
                        <TableCell>Inventory adjustment</TableCell>
                        <TableCell className="text-right tabular-nums">${money(jePreview.shrinkage)}</TableCell>
                        <TableCell className="text-right">—</TableCell>
                        <TableCell className="text-xs text-muted-foreground">Physical count — shrinkage</TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell>Inventory</TableCell>
                        <TableCell className="text-right">—</TableCell>
                        <TableCell className="text-right tabular-nums">${money(jePreview.shrinkage)}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">Shrinkage offset</TableCell>
                      </TableRow>
                    </>
                  )}
                  {jePreview.surplus === 0 && jePreview.shrinkage === 0 && (
                    <TableRow><TableCell colSpan={4} className="p-8 text-center text-sm text-muted-foreground">
                      Zero variance — no journal entry will be posted.
                    </TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
              <div className="mt-4 text-xs text-muted-foreground">
                Net impact: <span className={jePreview.net > 0 ? "text-emerald-600" : jePreview.net < 0 ? "text-red-600" : ""}>
                  ${money(jePreview.net)}
                </span> across {jePreview.lineCount} variance line{jePreview.lineCount === 1 ? "" : "s"}.
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="audit">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Event stream</CardTitle>
              <CardDescription>Append-only audit trail — created, frozen, submitted, approved, posted, reservations, reversals.</CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader><TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Event</TableHead>
                  <TableHead>Actor</TableHead>
                  <TableHead>Payload</TableHead>
                </TableRow></TableHeader>
                <TableBody>
                  {events.map((e) => (
                    <TableRow key={e.id}>
                      <TableCell className="text-xs text-muted-foreground">{new Date(e.created_at).toLocaleString()}</TableCell>
                      <TableCell><Badge variant="outline">{e.event_type}</Badge></TableCell>
                      <TableCell className="font-mono text-xs">{e.actor_id?.slice(0, 8) ?? "—"}</TableCell>
                      <TableCell><pre className="max-w-lg overflow-x-auto text-xs">{JSON.stringify(e.payload, null, 0)}</pre></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="drill">
          <Card>
            <CardHeader><CardTitle className="text-base">Ledger drill-down</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              {header.posted_journal_entry_id ? (
                <Button asChild variant="outline">
                  <Link to={`/reports/journal?entry=${header.posted_journal_entry_id}`}>
                    Open journal entry <ArrowRight className="ml-1 h-3 w-3" />
                  </Link>
                </Button>
              ) : (
                <div className="text-sm text-muted-foreground">Count not yet posted.</div>
              )}
              {header.posted_adjustment_ids?.map((aid) => (
                <div key={aid}>
                  <Button asChild variant="outline" size="sm">
                    <Link to={`/inventory/adjustments/${aid}`}>Stock adjustment {aid.slice(0, 8)} <ArrowRight className="ml-1 h-3 w-3" /></Link>
                  </Button>
                </div>
              ))}
              {header.cancellation_reason && (
                <div className="text-sm">
                  <span className="text-muted-foreground">Cancellation reason:</span> {header.cancellation_reason}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
