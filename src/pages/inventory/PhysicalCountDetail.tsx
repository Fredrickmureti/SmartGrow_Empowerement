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
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { toast } from "sonner";
import { AlertTriangle, ArrowRight, Loader2, RotateCcw, ShieldAlert, Undo2 } from "lucide-react";
import { normalizeError } from "@/services/resilience";
import { RecordHeader, ActionBar } from "@/design-system";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { useCurrency } from "@/hooks/useCurrency";
import { useOrganization } from "@/hooks/useOrganization";

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
  const { formatCurrency } = useCurrency();
  const { currentOrg } = useOrganization();

  // Solo governance override — when the org is in "solo" mode and has ≤1
  // active member, self-approval is auto-allowed. Suppress SoD blockers in
  // the UI and pass p_allow_self=true to the lifecycle RPCs.
  const soloQ = useQuery({
    queryKey: ["org-solo-mode", currentOrg?.id],
    enabled: !!currentOrg?.id,
    staleTime: 60_000,
    queryFn: async () => {
      const [{ data: org }, { count }] = await Promise.all([
        supabase.from("organizations").select("governance_mode").eq("id", currentOrg!.id).maybeSingle(),
        supabase.from("user_roles").select("user_id", { count: "exact", head: true })
          .eq("organization_id", currentOrg!.id).eq("is_active", true),
      ]);
      const mode = (org as { governance_mode?: string } | null)?.governance_mode ?? "solo";
      return { mode, members: count ?? 0 };
    },
  });
  const soloOverride = (soloQ.data?.mode ?? "solo") === "solo" && (soloQ.data?.members ?? 0) <= 1;


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

  // D5: server-authoritative preflight — drives action-bar disabled states + tooltips.
  const preflightQ = useQuery({
    queryKey: ["physical-count-preflight", id, user?.id],
    enabled: !!id && !!user?.id,
    queryFn: async () => {
      const { data, error } = await (supabase.rpc as unknown as (
        n: string, a: Record<string, unknown>,
      ) => Promise<{ data: unknown; error: { message: string } | null }>)(
        "physical_count_preflight", { p_count_id: id, p_user_id: user!.id },
      );
      if (error) throw error;
      return data as {
        state: string;
        checks: {
          period_open: boolean;
          period_status: string;
          inventory_account: boolean;
          adjustment_account: boolean;
          tolerance_flags: number;
          uncounted_lines: number;
          sod_submit_would_block: boolean;
          sod_approve_would_block: boolean;
          sod_post_would_block: boolean;
        };
        impact: { variance_lines: number; surplus_value: number; shrinkage_value: number; net_value: number };
      };
    },
  });

  // D5: server-authoritative JE preview — exact per-account lines the post will write.
  const previewQ = useQuery({
    queryKey: ["physical-count-preview-je", id],
    enabled: !!id,
    queryFn: async () => {
      const { data, error } = await (supabase.rpc as unknown as (
        n: string, a: Record<string, unknown>,
      ) => Promise<{ data: unknown; error: { message: string } | null }>)(
        "physical_count_preview_je", { p_count_id: id },
      );
      if (error) throw error;
      return data as {
        inventory_account: { code: string; name: string } | null;
        adjustment_account: { code: string; name: string } | null;
        surplus_value: number;
        shrinkage_value: number;
        net_value: number;
        journal_lines: Array<{ account: string; debit: number; credit: number; purpose: string }>;
        lines: Array<{ product_name: string; sku: string | null; variance_qty: number; unit_cost: number; value: number; direction: string }>;
      };
    },
  });

  const header = headerQ.data;
  const lines = linesQ.data ?? [];
  const events = eventsQ.data ?? [];
  const preflight = preflightQ.data;
  const preview = previewQ.data;

  const jePreview = useMemo(() => {
    // Prefer server preview; fall back to local computation for zero-latency render.
    if (preview) {
      return {
        surplus: preview.surplus_value,
        shrinkage: preview.shrinkage_value,
        net: preview.net_value,
        lineCount: preview.lines.length,
      };
    }
    let surplus = 0, shrinkage = 0;
    const varianceLines = lines.filter((l) => l.counted_qty !== null && l.variance_qty !== 0);
    for (const l of varianceLines) {
      const val = (l.variance_qty || 0) * (l.unit_cost_snapshot || 0);
      if (val > 0) surplus += val;
      else shrinkage += Math.abs(val);
    }
    return { surplus, shrinkage, net: surplus - shrinkage, lineCount: varianceLines.length };
  }, [lines, preview]);

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
      if (action === "approve" && !("p_allow_self" in args)) args.p_allow_self = soloOverride;
      if (action === "post" && !("p_allow_self" in args)) args.p_allow_self = soloOverride;
      if (action === "submit" && !("p_allow_self" in args)) args.p_allow_self = soloOverride;

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
      qc.invalidateQueries({ queryKey: ["physical-count-preflight", id] });
      qc.invalidateQueries({ queryKey: ["physical-count-preview-je", id] });
      qc.invalidateQueries({ queryKey: ["physical-counts-workspace"] });
      setSelected(new Set());
    } catch (err: unknown) {
      // Prefer server-supplied business messages (P0001 RAISE, 42501 governance)
      // over the canned normalizeError catalog so users see the actual reason.
      const e = err as { message?: string; code?: string; hint?: string } | null;
      const code = (e?.code || "").toString();
      const rawMsg = (e?.message || "").trim();
      const isBusinessError =
        rawMsg.length > 0 && (code === "P0001" || code === "42501" || code.startsWith("P"));
      if (isBusinessError) {
        toast.error(rawMsg, e?.hint ? { description: e.hint } : undefined);
      } else {
        toast.error(normalizeError(err).message);
      }
    } finally {
      setBusy(false);
    }
  };

  const handleApprove = () => {
    const flagged = preflight?.checks.tolerance_flags ?? 0;
    if (flagged > 0) {
      const reason = window.prompt(
        `${flagged} line(s) exceed tolerance. Type a written override reason to approve anyway, or Cancel to Request Recount instead.`,
      );
      if (!reason || !reason.trim()) return;
      runRpc("approve", { p_tolerance_override_reason: reason.trim() });
      return;
    }
    runRpc("approve");
  };

  const handlePost = () => {
    if (!preflight?.checks.period_open) {
      toast.error("Fiscal period is closed — reopen it in Accounting → Fiscal Periods first.");
      return;
    }
    if (!preflight.checks.inventory_account || !preflight.checks.adjustment_account) {
      toast.error("Default accounts missing (inventory / inventory_adjustment).");
      return;
    }
    runRpc("post");
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
        eyebrow={<Link to="/inventory-app/physical-counts" className="hover:underline">Physical Counts</Link>}
        title={<span className="font-mono">{header.count_number}</span>}
        meta={
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Badge className={STATE_STYLES[header.state]}>{header.state.replace("_", " ")}</Badge>
            <span>·</span>
            <span>{header.warehouses?.name ?? "—"}</span>
            <span>·</span>
            <span className="capitalize">{header.count_type}</span>
            {header.tolerance_pct != null && <><span>·</span><span>tol {header.tolerance_pct}%</span></>}
            {header.tolerance_value != null && <><span>·</span><span>tol {formatCurrency(header.tolerance_value)}</span></>}
          </div>
        }
        actions={
          <ActionBar>
            <RefreshButton queryKeyPrefixes={[["physical-count-detail", id] as const, ["physical-count-lines", id] as const, ["physical-count-preflight", id] as const]} tooltip="Refresh" />
            <TooltipProvider>
              {header.state === "draft" && (
                <Button size="sm" disabled={busy} onClick={() => runRpc("freeze")}>Freeze</Button>
              )}
              {header.state === "counting" && (
                <PreflightButton
                  label="Submit for review"
                  disabled={busy || (preflight?.checks.uncounted_lines ?? 0) > 0 || (!soloOverride && preflight?.checks.sod_submit_would_block === true)}
                  reason={
                    (preflight?.checks.uncounted_lines ?? 0) > 0
                      ? `${preflight?.checks.uncounted_lines} line(s) still uncounted`
                      : !soloOverride && preflight?.checks.sod_submit_would_block
                        ? "You created this count — ask another user to submit"
                        : undefined
                  }
                  onClick={() => runRpc("submit")}
                />
              )}
              {header.state === "in_review" && selected.size > 0 && (
                <Button size="sm" variant="outline" disabled={busy}
                        onClick={() => runRpc("request_recount", { p_line_ids: Array.from(selected) })}>
                  <RotateCcw className="mr-1 h-3 w-3" /> Recount {selected.size}
                </Button>
              )}
              {header.state === "in_review" && (
                <PreflightButton
                  label={(preflight?.checks.tolerance_flags ?? 0) > 0 ? `Approve (${preflight?.checks.tolerance_flags} flagged)` : "Approve"}
                  disabled={busy || (!soloOverride && preflight?.checks.sod_approve_would_block === true)}
                  reason={!soloOverride && preflight?.checks.sod_approve_would_block ? "Segregation of duties — you created, froze, or submitted this count" : undefined}
                  icon={(preflight?.checks.tolerance_flags ?? 0) > 0 ? <ShieldAlert className="mr-1 h-3 w-3" /> : undefined}
                  onClick={handleApprove}
                />
              )}
              {header.state === "approved" && (
                <PreflightButton
                  label="Post to ledger"
                  disabled={
                    busy ||
                    !preflight?.checks.period_open ||
                    !preflight?.checks.inventory_account ||
                    !preflight?.checks.adjustment_account ||
                    (!soloOverride && preflight?.checks.sod_post_would_block === true)
                  }
                  reason={
                    !preflight?.checks.period_open ? "Fiscal period is closed"
                    : !preflight?.checks.inventory_account ? "Default 'inventory' account not mapped"
                    : !preflight?.checks.adjustment_account ? "Default 'inventory_adjustment' account not mapped"
                    : !soloOverride && preflight?.checks.sod_post_would_block ? "You approved this count — another user must post"
                    : undefined
                  }
                  onClick={handlePost}
                />
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
            </TooltipProvider>
          </ActionBar>
        }
      />

      {preflight && (header.state === "in_review" || header.state === "approved" || header.state === "counting") && (
        <PreflightBanner preflight={preflight} suppressSod={soloOverride} />
      )}


      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Card><CardHeader className="pb-2"><CardTitle className="text-xs text-muted-foreground">Lines</CardTitle></CardHeader>
          <CardContent><div className="text-2xl font-bold">{lines.length}</div></CardContent></Card>
        <Card><CardHeader className="pb-2"><CardTitle className="text-xs text-muted-foreground">Variance lines</CardTitle></CardHeader>
          <CardContent><div className="text-2xl font-bold text-amber-600">
            {lines.filter((l) => l.counted_qty !== null && l.variance_qty !== 0).length}
          </div></CardContent></Card>
        <Card><CardHeader className="pb-2"><CardTitle className="text-xs text-muted-foreground">Surplus value</CardTitle></CardHeader>
          <CardContent><div className="text-2xl font-bold text-emerald-600">{formatCurrency(jePreview.surplus)}</div></CardContent></Card>
        <Card><CardHeader className="pb-2"><CardTitle className="text-xs text-muted-foreground">Shrinkage value</CardTitle></CardHeader>
          <CardContent><div className="text-2xl font-bold text-red-600">{formatCurrency(jePreview.shrinkage)}</div></CardContent></Card>
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
                        <TableCell className="text-right tabular-nums">{formatCurrency(l.unit_cost_snapshot ?? 0)}</TableCell>
                        <TableCell className={`text-right tabular-nums ${impact > 0 ? "text-emerald-600" : impact < 0 ? "text-red-600" : ""}`}>
                          {formatCurrency(impact)}
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
                Resolved server-side using the business's default accounts. The actual posting enforces open-fiscal-period checks, segregation of duties, and tolerance overrides.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader><TableRow>
                  <TableHead>Account</TableHead>
                  <TableHead className="text-right">Debit</TableHead>
                  <TableHead className="text-right">Credit</TableHead>
                  <TableHead>Purpose</TableHead>
                </TableRow></TableHeader>
                <TableBody>
                  {preview && (preview.surplus_value > 0 || preview.shrinkage_value > 0) ? preview.journal_lines.map((jl, i) => (
                    <TableRow key={i}>
                      <TableCell className="font-mono text-xs">{jl.account}</TableCell>
                      <TableCell className="text-right tabular-nums">{jl.debit > 0 ? formatCurrency(jl.debit) : "—"}</TableCell>
                      <TableCell className="text-right tabular-nums">{jl.credit > 0 ? formatCurrency(jl.credit) : "—"}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{jl.purpose}</TableCell>
                    </TableRow>
                  )) : (
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

              {preview && preview.lines.length > 0 && (
                <div className="mt-6">
                  <div className="mb-2 text-sm font-medium">Top contributors</div>
                  <Table>
                    <TableHeader><TableRow>
                      <TableHead>Product</TableHead>
                      <TableHead className="text-right">Variance</TableHead>
                      <TableHead className="text-right">Unit cost</TableHead>
                      <TableHead className="text-right">Value</TableHead>
                      <TableHead>Direction</TableHead>
                    </TableRow></TableHeader>
                    <TableBody>
                      {preview.lines.slice(0, 20).map((l, i) => (
                        <TableRow key={i}>
                          <TableCell>
                            <div className="font-medium">{l.product_name}</div>
                            {l.sku && <div className="text-xs text-muted-foreground">{l.sku}</div>}
                          </TableCell>
                          <TableCell className={`text-right tabular-nums ${l.variance_qty > 0 ? "text-emerald-600" : "text-red-600"}`}>
                            {money(l.variance_qty)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">${money(l.unit_cost)}</TableCell>
                          <TableCell className={`text-right tabular-nums ${l.value > 0 ? "text-emerald-600" : "text-red-600"}`}>${money(l.value)}</TableCell>
                          <TableCell><Badge variant="outline" className="capitalize">{l.direction}</Badge></TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
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
                    <Link to={`/inventory-app/adjustments/${aid}`}>Stock adjustment {aid.slice(0, 8)} <ArrowRight className="ml-1 h-3 w-3" /></Link>
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

/**
 * PreflightButton — wraps an action button in a Tooltip that surfaces the
 * server-computed reason the action is disabled. Keeps the button reachable
 * for keyboard users even when disabled so the tooltip fires.
 */
function PreflightButton(props: {
  label: string;
  disabled: boolean;
  reason?: string;
  icon?: React.ReactNode;
  onClick: () => void;
}) {
  const btn = (
    <Button size="sm" disabled={props.disabled} onClick={props.onClick}>
      {props.icon}
      {props.label}
    </Button>
  );
  if (!props.disabled || !props.reason) return btn;
  return (
    <Tooltip>
      <TooltipTrigger asChild><span tabIndex={0}>{btn}</span></TooltipTrigger>
      <TooltipContent><span className="text-xs">{props.reason}</span></TooltipContent>
    </Tooltip>
  );
}

/**
 * PreflightBanner — enterprise-style status strip summarising the exact
 * blockers between the current state and posting to the ledger.
 */
function PreflightBanner({ preflight }: {
  preflight: {
    checks: {
      period_open: boolean;
      period_status: string;
      inventory_account: boolean;
      adjustment_account: boolean;
      tolerance_flags: number;
      uncounted_lines: number;
      sod_submit_would_block: boolean;
      sod_approve_would_block: boolean;
      sod_post_would_block: boolean;
    };
  };
}) {
  const c = preflight.checks;
  const issues: string[] = [];
  if (!c.period_open) issues.push(`Fiscal period ${c.period_status} — reopen in Accounting → Fiscal Periods`);
  if (!c.inventory_account) issues.push("Default 'inventory' account not mapped");
  if (!c.adjustment_account) issues.push("Default 'inventory_adjustment' account not mapped");
  if (c.tolerance_flags > 0) issues.push(`${c.tolerance_flags} line(s) exceed tolerance — recount or approve with an override reason`);
  if (c.uncounted_lines > 0) issues.push(`${c.uncounted_lines} line(s) still uncounted`);
  if (c.sod_approve_would_block) issues.push("SoD: you created / froze / submitted this count and cannot approve it");
  if (c.sod_post_would_block) issues.push("SoD: you approved this count and cannot also post it");

  if (issues.length === 0) return null;
  return (
    <Alert variant="destructive" className="border-amber-500/40 bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
      <AlertTriangle className="h-4 w-4" />
      <AlertTitle>Preflight — action blocked</AlertTitle>
      <AlertDescription>
        <ul className="ml-4 list-disc space-y-0.5 text-sm">
          {issues.map((i) => <li key={i}>{i}</li>)}
        </ul>
      </AlertDescription>
    </Alert>
  );
}
