/**
 * Physical Count Detail Workspace
 *
 * Line-level enterprise view over a single physical_counts aggregate.
 * All actions call D2/D4 lifecycle RPCs — no client-side ledger writes.
 *
 * The page is organised around the count's WORKFLOW, not around raw data:
 *  1. Workflow stepper      — where the document is in its lifecycle.
 *  2. Next-action card       — the single primary action, who does it, and why
 *                              it may be blocked (plain-English, preflight-fed).
 *  3. At-a-glance summary    — variance / inventory impact.
 *  4. Tabs                   — Lines, JE preview, Recounts, Activity, Drill-down.
 * Terminal states (posted / cancelled / superseded) render as read-only
 * audit records.
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
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { toast } from "sonner";
import {
  AlertTriangle, ArrowRight, Loader2, RotateCcw, ShieldAlert, Undo2,
  Snowflake, Send, CheckCircle2, PackageCheck, XCircle, Lock, History,
  ClipboardCheck, Ban, CircleDot,
} from "lucide-react";
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

// The happy-path lifecycle rendered by the stepper.
const STAGES: { key: CountState; label: string }[] = [
  { key: "draft", label: "Draft" },
  { key: "counting", label: "Counting" },
  { key: "in_review", label: "In review" },
  { key: "approved", label: "Approved" },
  { key: "posted", label: "Posted" },
];

const TERMINAL: CountState[] = ["posted", "cancelled", "superseded"];

const money = (n: number | null | undefined) =>
  (n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Human-readable label + icon for each audit event type.
const EVENT_META: Record<string, { label: string; icon: React.ComponentType<{ className?: string }> }> = {
  created: { label: "Count created", icon: ClipboardCheck },
  frozen: { label: "Stock frozen", icon: Snowflake },
  submitted: { label: "Submitted for review", icon: Send },
  recount_requested: { label: "Recount requested", icon: RotateCcw },
  approved: { label: "Approved", icon: CheckCircle2 },
  posted: { label: "Posted to ledger", icon: PackageCheck },
  cancelled: { label: "Cancelled", icon: Ban },
  superseded: { label: "Reversed / superseded", icon: Undo2 },
};

export default function PhysicalCountDetail() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Inline recount entry: lineId -> draft quantity string (while re-counting).
  const [recountDrafts, setRecountDrafts] = useState<Record<string, string>>({});
  const [savingLine, setSavingLine] = useState<string | null>(null);
  // Tolerance override dialog (sandbox-safe replacement for window.prompt).
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [overrideReason, setOverrideReason] = useState("");
  const { formatCurrency } = useCurrency();
  const { currentOrg } = useOrganization();

  // Solo governance override — when the org is in "solo" mode and has ≤1
  // active member, self-approval is auto-allowed. Suppress SoD blockers in
  // the UI. (The DB engine decides authoritatively; this only drives display.)
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
          period_defined: boolean;
          period_status: string;
          inventory_account: boolean;
          adjustment_account: boolean;
          journal_book: boolean;
          warehouse_active: boolean;
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

  const productName = useMemo(() => {
    const m = new Map<string, string>();
    lines.forEach((l) => m.set(l.product_id, l.products?.name ?? l.product_id));
    return m;
  }, [lines]);

  // Recount rounds reconstructed from the append-only event stream (oldest → newest).
  const recountRounds = useMemo(() => {
    return events
      .filter((e) => e.event_type === "recount_requested")
      .map((e) => ({
        id: e.id,
        at: e.created_at,
        actor: e.actor_id,
        round: (e.payload?.round as number | undefined) ?? null,
        lineCount: (e.payload?.lines as number | undefined) ?? null,
        previous: (e.payload?.previous as Array<{
          line_id: string; product_id: string; previous_qty: number | null; previous_variance: number | null;
        }> | undefined) ?? [],
      }))
      .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  }, [events]);

  const jePreview = useMemo(() => {
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

      // NOTE: p_allow_self is intentionally NOT sent. Separation-of-duties is
      // decided server-side by governance_assert_not_self (governance_mode +
      // self_action_policy + overrides). Sending it was both dead weight and
      // the cause of the RPC overload ambiguity that has since been removed.
      const args: Record<string, unknown> = { p_user_id: user.id, ...extra };
      if (action === "supersede") args.p_source_count_id = id;
      else args.p_count_id = id;

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
      const e = err as { message?: string; code?: string; hint?: string; details?: string } | null;
      const code = (e?.code || "").toString();
      const rawMsg = (e?.message || "").trim();
      // Any Postgres error (P*, 23xxx integrity, 42xxx permission/syntax) carries
      // real business context in `message` / `hint` / `details`. Surface it verbatim
      // instead of collapsing it to the generic "Some of the information you entered
      // is not valid" toast that hides the actual blocker.
      const isPostgresError =
        rawMsg.length > 0 && /^(P|23|42)/.test(code);
      if (isPostgresError) {
        const description = e?.hint || e?.details || undefined;
        toast.error(rawMsg, description ? { description } : undefined);
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
      // Flagged lines that still have no recorded (re)count cannot be
      // approved-over — they must be recounted first. Only offer the written
      // override when every flagged line actually has a counted value.
      const unresolved = lines.filter(
        (l) => l.status === "recount_required" && l.counted_qty == null,
      ).length;
      if (unresolved > 0) {
        toast.error(
          `${unresolved} recount-flagged line(s) have no recorded count yet`,
          { description: "Enter their new counts in the Lines tab, then approve." },
        );
        return;
      }
      setOverrideReason("");
      setOverrideOpen(true);
      return;
    }
    runRpc("approve");
  };

  const confirmOverrideApprove = () => {
    const reason = overrideReason.trim();
    if (!reason) return;
    setOverrideOpen(false);
    runRpc("approve", { p_tolerance_override_reason: reason });
  };

  // Record (or re-record) a line's counted quantity. The DB RPC accepts this
  // while the count is in `counting` OR `in_review`, so a reviewer can resolve
  // a recount-flagged line in place — clearing `recount_required` and
  // unblocking approval without a destructive state bounce.
  const recordRecountLine = async (line: CountLine) => {
    if (!user?.id || !id) return;
    const raw = recountDrafts[line.id];
    if (raw == null || raw.trim() === "") {
      toast.error("Enter a counted quantity first");
      return;
    }
    const qty = Number(raw);
    if (!Number.isFinite(qty) || qty < 0) {
      toast.error("Counted quantity must be a non-negative number");
      return;
    }
    setSavingLine(line.id);
    try {
      const { data, error } = await (supabase.rpc as unknown as (
        n: string, a: Record<string, unknown>,
      ) => Promise<{ data: unknown; error: { message: string } | null }>)(
        "physical_count_record_line",
        { p_count_id: id, p_product_id: line.product_id, p_counted_qty: qty, p_user_id: user.id },
      );
      if (error) throw error;
      const res = data as { success?: boolean; error?: string } | null;
      if (res && res.success === false) throw new Error(res.error || "record failed");
      toast.success(`Recount saved for ${line.products?.name ?? "line"}`);
      setRecountDrafts((prev) => {
        const next = { ...prev };
        delete next[line.id];
        return next;
      });
      qc.invalidateQueries({ queryKey: ["physical-count-lines", id] });
      qc.invalidateQueries({ queryKey: ["physical-count-preflight", id] });
      qc.invalidateQueries({ queryKey: ["physical-count-preview-je", id] });
    } catch (err: unknown) {
      const e = err as { message?: string; code?: string } | null;
      const rawMsg = (e?.message || "").trim();
      toast.error(rawMsg || normalizeError(err).message);
    } finally {
      setSavingLine(null);
    }
  };

  const handlePost = () => {
    const c = preflight?.checks;
    if (c?.period_defined === false) {
      toast.error("No fiscal period defined for today's date.", {
        description: "Open Accounting → Fiscal Periods and create a period that covers today before posting.",
      });
      return;
    }
    if (c && !c.period_open) {
      toast.error("Fiscal period is closed.", {
        description: "Reopen it in Accounting → Fiscal Periods first.",
      });
      return;
    }
    if (c && (!c.inventory_account || !c.adjustment_account)) {
      toast.error("Default GL accounts are not mapped.", {
        description: "Map the Inventory and Inventory Adjustment accounts under Accounting → Default Accounts.",
      });
      return;
    }
    if (c && c.journal_book === false) {
      toast.error("No active journal book configured.", {
        description: "Create a General journal book under Accounting → Journal Books before posting.",
      });
      return;
    }
    if (c && c.warehouse_active === false) {
      toast.error("Warehouse is not active.", {
        description: "Reactivate the warehouse under Inventory → Warehouses.",
      });
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

  const isTerminal = TERMINAL.includes(header.state);

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
            <RefreshButton queryKeyPrefixes={[["physical-count-detail", id] as const, ["physical-count-lines", id] as const, ["physical-count-preflight", id] as const, ["physical-count-events", id] as const]} tooltip="Refresh" />
            {/* ADR 0106 — the same paperwork the Warehouse app produces, for
              * counts started in Inventory. The count sheet is only useful
              * while counting; the evidence reports carry the sign-off block
              * (counted / reviewed / approved / posted by). */}
            <CountDocumentsMenu
              sessionId={header.id}
              countNumber={header.count_number}
              size="sm"
              only={
                ["draft", "counting"].includes(header.state)
                  ? ["count_sheet"]
                  : ["count_sheet", "count_variance_report", "count_audit_report"]
              }
            />

            {/* Recount is a contextual action available while lines are selected in review. */}
            {header.state === "in_review" && selected.size > 0 && (
              <Button size="sm" variant="outline" disabled={busy}
                      onClick={() => runRpc("request_recount", { p_line_ids: Array.from(selected) })}>
                <RotateCcw className="mr-1 h-3 w-3" /> Recount {selected.size}
              </Button>
            )}
            {/* Secondary lifecycle actions. The primary next step lives in the Next-action card. */}
            {["draft", "counting", "in_review", "approved"].includes(header.state) && (
              <Button size="sm" variant="destructive" disabled={busy}
                      onClick={() => {
                        const reason = window.prompt("Reason for cancelling this count?", "Cancelled");
                        if (reason) runRpc("cancel", { p_reason: reason });
                      }}>
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

      <WorkflowStepper state={header.state} />

      <NextActionCard
        state={header.state}
        preflight={preflight}
        soloOverride={soloOverride}
        busy={busy}
        selectedCount={selected.size}
        onFreeze={() => runRpc("freeze")}
        onSubmit={() => runRpc("submit")}
        onApprove={handleApprove}
        onPost={handlePost}
      />

      {isTerminal && (
        <Alert className="border-border bg-muted/40">
          <Lock className="h-4 w-4" />
          <AlertTitle>
            {header.state === "posted" ? "Posted — read-only audit record"
              : header.state === "cancelled" ? "Cancelled — read-only audit record"
              : "Superseded — read-only audit record"}
          </AlertTitle>
          <AlertDescription className="text-sm">
            {header.state === "posted"
              ? "Inventory levels and the general ledger have been updated. To change stock, reverse this count or record a new adjustment."
              : header.state === "cancelled"
              ? (header.cancellation_reason ? `Reason: ${header.cancellation_reason}` : "This count was cancelled and had no ledger impact.")
              : "This count was reversed by a later document. Its history is preserved for audit."}
          </AlertDescription>
        </Alert>
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
          <TabsTrigger value="recounts">Recounts ({recountRounds.length})</TabsTrigger>
          <TabsTrigger value="audit">Activity ({events.length})</TabsTrigger>
          <TabsTrigger value="drill">Drill-down</TabsTrigger>
        </TabsList>

        <TabsContent value="lines">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Count lines</CardTitle>
              <CardDescription>
                Variance = counted − (system + freeze-window reconciliation).{" "}
                {header.state === "in_review"
                  ? "Select rows and use Recount to send them back for a re-count."
                  : "Recount selection is available while the count is in review."}
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
                    // A line can be (re)counted in place while the count is
                    // being counted or reviewed. Recount-flagged or never-
                    // counted lines are the ones that block approval.
                    const editable = header.state === "counting" || header.state === "in_review";
                    const needsCount =
                      l.counted_qty == null &&
                      (l.status === "recount_required" || l.status === "pending");
                    const showEntry = editable && (needsCount || l.status === "recount_required");
                    return (
                      <TableRow
                        key={l.id}
                        className={
                          l.status === "recount_required"
                            ? "bg-amber-50/60"
                            : l.variance_qty !== 0 ? "" : "opacity-60"
                        }
                      >
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
                        <TableCell className="text-right tabular-nums">
                          {showEntry ? (
                            <div className="flex items-center justify-end gap-1">
                              <Input
                                type="number"
                                inputMode="decimal"
                                className="h-8 w-24 text-right"
                                placeholder={l.counted_qty == null ? "recount" : money(l.counted_qty)}
                                value={recountDrafts[l.id] ?? ""}
                                onChange={(e) =>
                                  setRecountDrafts((prev) => ({ ...prev, [l.id]: e.target.value }))
                                }
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") { e.preventDefault(); void recordRecountLine(l); }
                                }}
                              />
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-8 px-2"
                                disabled={savingLine === l.id || (recountDrafts[l.id] ?? "").trim() === ""}
                                onClick={() => void recordRecountLine(l)}
                              >
                                {savingLine === l.id
                                  ? <Loader2 className="h-3 w-3 animate-spin" />
                                  : <ClipboardCheck className="h-3 w-3" />}
                              </Button>
                            </div>
                          ) : (
                            l.counted_qty == null ? "—" : money(l.counted_qty)
                          )}
                        </TableCell>
                        <TableCell className={`text-right tabular-nums font-semibold ${l.variance_qty > 0 ? "text-emerald-600" : l.variance_qty < 0 ? "text-red-600" : ""}`}>
                          {money(l.variance_qty)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{formatCurrency(l.unit_cost_snapshot ?? 0)}</TableCell>
                        <TableCell className={`text-right tabular-nums ${impact > 0 ? "text-emerald-600" : impact < 0 ? "text-red-600" : ""}`}>
                          {formatCurrency(impact)}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={l.status === "recount_required" ? "destructive" : "outline"}
                            className="capitalize"
                          >
                            {l.status.replace("_", " ")}
                          </Badge>
                        </TableCell>
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
                  {formatCurrency(jePreview.net)}
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
                          <TableCell className="text-right tabular-nums">{formatCurrency(l.unit_cost)}</TableCell>
                          <TableCell className={`text-right tabular-nums ${l.value > 0 ? "text-emerald-600" : "text-red-600"}`}>{formatCurrency(l.value)}</TableCell>
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

        <TabsContent value="recounts">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Recount history</CardTitle>
              <CardDescription>
                Every recount round is preserved. Requesting a recount sends the selected
                lines back for re-counting without discarding the previous figures.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {recountRounds.length === 0 && (
                <div className="p-6 text-center text-sm text-muted-foreground">
                  No recounts requested for this count.
                </div>
              )}
              {recountRounds.map((r) => (
                <div key={r.id} className="rounded-lg border">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/30 px-4 py-2">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <RotateCcw className="h-4 w-4" />
                      Round {r.round ?? "?"} · {r.lineCount ?? r.previous.length} line{(r.lineCount ?? r.previous.length) === 1 ? "" : "s"}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {new Date(r.at).toLocaleString()} · by {r.actor?.slice(0, 8) ?? "—"}
                    </div>
                  </div>
                  {r.previous.length > 0 ? (
                    <Table>
                      <TableHeader><TableRow>
                        <TableHead>Product</TableHead>
                        <TableHead className="text-right">Previous counted</TableHead>
                        <TableHead className="text-right">Previous variance</TableHead>
                      </TableRow></TableHeader>
                      <TableBody>
                        {r.previous.map((p) => (
                          <TableRow key={p.line_id}>
                            <TableCell className="font-medium">{productName.get(p.product_id) ?? p.product_id}</TableCell>
                            <TableCell className="text-right tabular-nums">{p.previous_qty == null ? "—" : money(p.previous_qty)}</TableCell>
                            <TableCell className="text-right tabular-nums">{p.previous_variance == null ? "—" : money(p.previous_variance)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  ) : (
                    <div className="px-4 py-3 text-xs text-muted-foreground">
                      Previous quantities were not captured for this round.
                    </div>
                  )}
                </div>
              ))}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="audit">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Activity timeline</CardTitle>
              <CardDescription>Append-only audit trail — created, frozen, submitted, recount, approved, posted, reversals.</CardDescription>
            </CardHeader>
            <CardContent>
              {events.length === 0 ? (
                <div className="p-6 text-center text-sm text-muted-foreground">No activity yet.</div>
              ) : (
                <ol className="relative space-y-5 border-l pl-6">
                  {events.map((e) => {
                    const meta = EVENT_META[e.event_type] ?? { label: e.event_type.replace(/_/g, " "), icon: CircleDot };
                    const Icon = meta.icon;
                    return (
                      <li key={e.id} className="relative">
                        <span className="absolute -left-[31px] flex h-6 w-6 items-center justify-center rounded-full border bg-background">
                          <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                        </span>
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                          <span className="text-sm font-medium">{meta.label}</span>
                          <span className="text-xs text-muted-foreground">{new Date(e.created_at).toLocaleString()}</span>
                        </div>
                        <div className="text-xs text-muted-foreground">
                          Actor {e.actor_id?.slice(0, 8) ?? "system"}
                          {renderEventDetail(e)}
                        </div>
                      </li>
                    );
                  })}
                </ol>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="drill">
          <Card>
            <CardHeader><CardTitle className="text-base">Ledger drill-down</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              {header.posted_journal_entry_id ? (
                <Button asChild variant="outline">
                  <Link to={`/finance/journal-entries/${header.posted_journal_entry_id}`}>
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

      <Dialog open={overrideOpen} onOpenChange={setOverrideOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Approve with tolerance override</DialogTitle>
            <DialogDescription>
              {(preflight?.checks.tolerance_flags ?? 0)} line(s) exceed the counting
              tolerance. Approving now accepts these variances as-is. Provide a written
              reason — it is recorded permanently in the audit trail.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="override-reason">Override reason</Label>
            <Textarea
              id="override-reason"
              value={overrideReason}
              onChange={(e) => setOverrideReason(e.target.value)}
              placeholder="e.g. Physical stock verified against supplier delivery note; variance accepted."
              rows={4}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOverrideOpen(false)}>Cancel</Button>
            <Button
              disabled={busy || overrideReason.trim().length === 0}
              onClick={confirmOverrideApprove}
            >
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Approve with override
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Compact inline description for an event row. */
function renderEventDetail(e: CountEvent): React.ReactNode {
  const p = e.payload ?? {};
  switch (e.event_type) {
    case "recount_requested":
      return ` · round ${(p.round as number) ?? "?"}, ${(p.lines as number) ?? 0} line(s)`;
    case "submitted":
      return typeof p.lines_flagged_recount === "number" && p.lines_flagged_recount > 0
        ? ` · ${p.lines_flagged_recount} line(s) flagged over tolerance`
        : null;
    case "approved":
      return p.tolerance_override_reason
        ? ` · override: ${String(p.tolerance_override_reason)}`
        : typeof p.flagged_lines_at_approval === "number" && p.flagged_lines_at_approval > 0
          ? ` · ${p.flagged_lines_at_approval} flagged at approval`
          : null;
    default:
      return null;
  }
}

/**
 * WorkflowStepper — horizontal lifecycle indicator. Terminal off-path states
 * (cancelled / superseded) are surfaced distinctly at the end.
 */
function WorkflowStepper({ state }: { state: CountState }) {
  const normalized: CountState = state === "counted" ? "counting" : state;
  const activeIdx =
    state === "cancelled" || state === "superseded"
      ? -1
      : STAGES.findIndex((s) => s.key === normalized);
  const off = state === "cancelled" || state === "superseded";

  return (
    <div className="flex flex-wrap items-center gap-1 rounded-lg border bg-card p-3">
      {STAGES.map((s, i) => {
        const done = !off && i < activeIdx;
        const active = !off && i === activeIdx;
        return (
          <div key={s.key} className="flex items-center">
            <div
              className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ${
                active ? "bg-primary text-primary-foreground"
                  : done ? "bg-emerald-100 text-emerald-800"
                  : "bg-muted text-muted-foreground"
              }`}
            >
              {done ? <CheckCircle2 className="h-3.5 w-3.5" /> : active ? <CircleDot className="h-3.5 w-3.5" /> : <CircleDot className="h-3.5 w-3.5 opacity-40" />}
              {s.label}
            </div>
            {i < STAGES.length - 1 && <ArrowRight className="mx-0.5 h-3 w-3 text-muted-foreground/50" />}
          </div>
        );
      })}
      {off && (
        <>
          <ArrowRight className="mx-0.5 h-3 w-3 text-muted-foreground/50" />
          <div className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ${STATE_STYLES[state]}`}>
            {state === "cancelled" ? <Ban className="h-3.5 w-3.5" /> : <Undo2 className="h-3.5 w-3.5" />}
            {state === "cancelled" ? "Cancelled" : "Superseded"}
          </div>
        </>
      )}
    </div>
  );
}

type Preflight = {
  checks: {
    period_open: boolean;
    period_defined?: boolean;
    period_status: string;
    inventory_account: boolean;
    adjustment_account: boolean;
    journal_book?: boolean;
    warehouse_active?: boolean;
    tolerance_flags: number;
    uncounted_lines: number;
    sod_submit_would_block: boolean;
    sod_approve_would_block: boolean;
    sod_post_would_block: boolean;
  };
};

/**
 * NextActionCard — the single, prominent driver of the workflow. Explains in
 * plain English what just happened, what the next step is, who performs it,
 * and surfaces the exact blocker (from server preflight) when the action can't
 * proceed. Terminal states render an informational card with no CTA.
 */
function NextActionCard({
  state, preflight, soloOverride, busy, selectedCount,
  onFreeze, onSubmit, onApprove, onPost,
}: {
  state: CountState;
  preflight: Preflight | undefined;
  soloOverride: boolean;
  busy: boolean;
  selectedCount: number;
  onFreeze: () => void;
  onSubmit: () => void;
  onApprove: () => void;
  onPost: () => void;
}) {
  const c = preflight?.checks;

  const config = (() => {
    switch (state) {
      case "draft":
        return {
          title: "Ready to freeze",
          body: "This count is a draft. Freezing snapshots current warehouse stock and opens the count for entry. Anyone with inventory access can do this.",
          cta: { label: "Freeze & start counting", icon: <Snowflake className="mr-1 h-4 w-4" />, onClick: onFreeze, disabled: busy, reason: undefined as string | undefined },
        };
      case "counting":
      case "counted": {
        const uncounted = c?.uncounted_lines ?? 0;
        const sod = !soloOverride && c?.sod_submit_would_block === true;
        return {
          title: "Counting in progress",
          body: "Record a counted quantity for every line, then submit the count for review. The reviewer should be a different person from the counter.",
          cta: {
            label: "Submit for review",
            icon: <Send className="mr-1 h-4 w-4" />,
            onClick: onSubmit,
            disabled: busy || uncounted > 0 || sod,
            reason: uncounted > 0 ? `${uncounted} line(s) still uncounted`
              : sod ? "You created this count — ask another user to submit"
              : undefined,
          },
        };
      }
      case "in_review": {
        const flagged = c?.tolerance_flags ?? 0;
        const sod = !soloOverride && c?.sod_approve_would_block === true;
        return {
          title: "Awaiting approval",
          body: flagged > 0
            ? `${flagged} line(s) exceed tolerance. Select them and Request Recount, or approve with a written override reason. Approval must come from someone who did not create, freeze, or submit this count.`
            : "A reviewer approves the variances, or selects lines and requests a recount. Approval must come from someone who did not create, freeze, or submit this count."
            + (selectedCount > 0 ? ` (${selectedCount} line(s) selected for recount — use the Recount button above.)` : ""),
          cta: {
            label: flagged > 0 ? `Approve (${flagged} flagged)` : "Approve",
            icon: flagged > 0 ? <ShieldAlert className="mr-1 h-4 w-4" /> : <CheckCircle2 className="mr-1 h-4 w-4" />,
            onClick: onApprove,
            disabled: busy || sod,
            reason: sod ? "Segregation of duties — you created, froze, or submitted this count" : undefined,
          },
        };
      }
      case "approved": {
        const blocked =
          c?.period_defined === false ? "No fiscal period defined for today — create one in Accounting → Fiscal Periods"
          : !c?.period_open ? "Fiscal period is closed — reopen it in Accounting → Fiscal Periods"
          : !c?.inventory_account ? "Default 'inventory' account not mapped"
          : !c?.adjustment_account ? "Default 'inventory_adjustment' account not mapped"
          : c?.journal_book === false ? "No active journal book — create a General journal book in Accounting → Journal Books"
          : c?.warehouse_active === false ? "Warehouse is not active — reactivate it in Inventory → Warehouses"
          : (!soloOverride && c?.sod_post_would_block) ? "You approved this count — another user must post it"
          : undefined;
        return {
          title: "Approved — ready to post",
          body: "Posting writes the stock adjustment and the general-ledger journal entry. The poster must be different from the approver.",
          cta: {
            label: "Post to ledger",
            icon: <PackageCheck className="mr-1 h-4 w-4" />,
            onClick: onPost,
            disabled: busy || !!blocked,
            reason: blocked,
          },
        };
      }
      case "posted":
        return { title: "Completed", body: "Inventory and the general ledger have been updated. This count is now a read-only audit record.", cta: null };
      case "cancelled":
        return { title: "Cancelled", body: "This count was cancelled and has no ledger impact.", cta: null };
      case "superseded":
        return { title: "Superseded", body: "This count was reversed by a later document and is retained for audit.", cta: null };
      default:
        return { title: "", body: "", cta: null };
    }
  })();

  const StatusIcon = state === "posted" ? PackageCheck
    : state === "cancelled" ? XCircle
    : state === "superseded" ? Undo2
    : CircleDot;

  return (
    <Card>
      <CardContent className="flex flex-col gap-4 p-4 md:flex-row md:items-center md:justify-between md:p-5">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted">
            <StatusIcon className="h-4.5 w-4.5 text-foreground" />
          </span>
          <div>
            <div className="text-sm font-semibold">{config.title}</div>
            <p className="mt-0.5 max-w-2xl text-sm text-muted-foreground">{config.body}</p>
          </div>
        </div>
        {config.cta && (
          <div className="shrink-0">
            <TooltipProvider>
              {config.cta.disabled && config.cta.reason ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span tabIndex={0}>
                      <Button disabled onClick={config.cta.onClick}>
                        {config.cta.icon}{config.cta.label}
                      </Button>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent><span className="text-xs">{config.cta.reason}</span></TooltipContent>
                </Tooltip>
              ) : (
                <Button disabled={config.cta.disabled} onClick={config.cta.onClick}>
                  {config.cta.icon}{config.cta.label}
                </Button>
              )}
            </TooltipProvider>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
