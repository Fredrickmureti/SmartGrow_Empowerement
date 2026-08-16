/**
 * useLabelRuns — client seam for the Label Operations Engine.
 *
 * A label run is a *server-owned* unit of work: the browser submits a
 * selection predicate, the server expands it into run lines and print
 * jobs, and the same drainer that prints a single button-press label
 * prints every line. The browser is therefore free to close — the run
 * keeps going, and its progress is recoverable.
 *
 * This hook deliberately exposes no per-item print loop. Bulk printing
 * from a client `for` loop is the failure mode the engine replaces:
 * it cannot survive a tab close, has no ledger, no retry, and no audit
 * trail of what actually reached paper.
 */
import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBranches } from "@/hooks/useBranches";
import type { PrinterWorkflow } from "@/services/printing/labelDispatch";
import { drainLabelRunJobs } from "@/services/printing/labelRunDrain";


export type LabelEntityType = "product" | "location" | "lot" | "carton" | "pallet";
export type LabelRunStatus =
  | "draft" | "expanding" | "running" | "paused" | "completed" | "failed" | "cancelled";
export type LabelDemandReason =
  | "goods_receipt" | "price_change" | "barcode_enrolled"
  | "product_import" | "promotion" | "recount" | "manual";

export interface LabelRun {
  id: string;
  name: string | null;
  template_key: string;
  workflow: string;
  entity_type: LabelEntityType;
  copies: number;
  status: LabelRunStatus;
  expansion_complete: boolean;
  total_lines: number;
  queued_lines: number;
  printed_lines: number;
  failed_lines: number;
  refused_lines: number;
  last_error: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface LabelRunLine {
  id: string;
  entity_id: string;
  entity_label: string | null;
  copies: number;
  status: "pending" | "queued" | "printed" | "failed" | "refused";
  error: string | null;
  resolved_vars: Record<string, unknown>;
}

export interface LabelDemandRow {
  id: string;
  entity_type: LabelEntityType;
  entity_id: string;
  reason: LabelDemandReason;
  qty_hint: number;
  suggested_template_key: string | null;
  status: "open" | "queued" | "dismissed";
  created_at: string;
  detail: Record<string, unknown>;
}

export type LabelSelection =
  | { kind: "product_ids"; ids: string[] }
  | {
      kind: "product_filter";
      /**
       * Submit a saved product view instead of ids. The server re-derives
       * the predicate from the view at expansion time, so a view covering
       * the whole catalogue never has to travel through the browser.
       * Any explicit key below narrows the view further.
       */
      saved_view_id?: string | null;
      search?: string | null;
      category_id?: string | null;
      is_active?: boolean;
      only_with_barcode?: boolean;
    }

  | { kind: "location_ids"; ids: string[] }
  | { kind: "carton_ids"; ids: string[] }
  /** Every carton on a packing wave — sealed only unless told otherwise. */
  | { kind: "pack_wave"; wave_id: string; sealed_only?: boolean }
  | { kind: "demand"; reason?: LabelDemandReason | null };


export interface CreateLabelRunArgs {
  templateKey: string;
  workflow: PrinterWorkflow;
  selection: LabelSelection;
  entityType?: LabelEntityType;
  copies?: number;
  name?: string;
  warehouseId?: string | null;
}

const RUNS_KEY = "label-print-runs";
const DEMAND_KEY = "label-demand";

/** Ask the engine to advance a run now instead of waiting for the cron tick. */
async function kickRun(runId: string) {
  try {
    await supabase.functions.invoke("dispatch-label-runs", { body: { run_id: runId } });
  } catch {
    /* cron will pick it up — the run is already durable */
  }
  // Expansion is server-side, but the last mile is not always: printers bound
  // to this session (network / USB, no paired workstation) can only be reached
  // from here. Drain in the background so the operator is never blocked, and
  // so bulk lines print through the same seam a single label does.
  void drainLabelRunJobs(runId);
}


export function useLabelRuns(businessId?: string | null) {
  return useQuery({
    queryKey: [RUNS_KEY, businessId],
    enabled: !!businessId,
    refetchInterval: 5000,
    queryFn: async (): Promise<LabelRun[]> => {
      const { data, error } = await supabase
        .from("label_print_runs")
        .select(
          "id, name, template_key, workflow, entity_type, copies, status, expansion_complete, " +
            "total_lines, queued_lines, printed_lines, failed_lines, refused_lines, last_error, created_at, completed_at",
        )
        .eq("business_id", businessId!)
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return (data ?? []) as unknown as LabelRun[];
    },
  });
}

export function useLabelRunLines(runId?: string | null, status?: LabelRunLine["status"] | "all") {
  return useQuery({
    queryKey: ["label-run-lines", runId, status ?? "all"],
    enabled: !!runId,
    refetchInterval: 5000,
    queryFn: async (): Promise<LabelRunLine[]> => {
      let q = supabase
        .from("label_print_run_lines")
        .select("id, entity_id, entity_label, copies, status, error, resolved_vars")
        .eq("run_id", runId!)
        .order("created_at", { ascending: true })
        .limit(200);
      if (status && status !== "all") q = q.eq("status", status);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as unknown as LabelRunLine[];
    },
  });
}

/**
 * Demand rows carry only the raw `entity_id` plus whatever the emitting
 * trigger stashed in `detail` (usually a source tag or a barcode). Showing
 * a truncated uuid to an operator is useless — they pick items by name.
 * So the hook resolves product identities in one batched follow-up read
 * and folds `name`/`sku` into `detail` for the table to render.
 */
export function useLabelDemand(businessId?: string | null, reason?: LabelDemandReason | "all") {
  return useQuery({
    queryKey: [DEMAND_KEY, businessId, reason ?? "all"],
    enabled: !!businessId,
    queryFn: async (): Promise<LabelDemandRow[]> => {
      let q = supabase
        .from("label_demand")
        .select("id, entity_type, entity_id, reason, qty_hint, suggested_template_key, status, created_at, detail")
        .eq("business_id", businessId!)
        .eq("status", "open")
        .order("created_at", { ascending: false })
        .limit(300);
      if (reason && reason !== "all") q = q.eq("reason", reason);
      const { data, error } = await q;
      if (error) throw error;
      const rows = (data ?? []) as unknown as LabelDemandRow[];

      const productIds = Array.from(
        new Set(rows.filter((r) => r.entity_type === "product").map((r) => r.entity_id)),
      );
      if (!productIds.length) return rows;

      const { data: products, error: prodError } = await supabase
        .from("products")
        .select("id, name, sku")
        .in("id", productIds);
      // A failed name lookup must not blank the demand queue; fall back to
      // whatever `detail` already had.
      if (prodError) return rows;

      const byId = new Map((products ?? []).map((p) => [p.id, p]));
      return rows.map((r) => {
        const p = r.entity_type === "product" ? byId.get(r.entity_id) : undefined;
        if (!p) return r;
        return {
          ...r,
          detail: {
            ...r.detail,
            name: (r.detail?.["name"] as string | undefined) ?? p.name,
            sku: (r.detail?.["sku"] as string | undefined) ?? p.sku ?? undefined,
          },
        };
      });
    },
  });
}


export function useLabelRunActions(businessId?: string | null) {
  const qc = useQueryClient();
  const { currentOrg } = useOrganization();
  const { currentBranch } = useBranches();

  const invalidate = useCallback(() => {
    qc.invalidateQueries({ queryKey: [RUNS_KEY] });
    qc.invalidateQueries({ queryKey: [DEMAND_KEY] });
  }, [qc]);

  const createRun = useMutation({
    mutationFn: async (args: CreateLabelRunArgs): Promise<string> => {
      if (!businessId) throw new Error("No business selected");
      if (!currentOrg?.id) throw new Error("No organization selected");
      const { data, error } = await supabase.rpc("create_label_run", {
        p_business_id: businessId,
        p_template_key: args.templateKey,
        p_workflow: args.workflow,
        p_selection_spec: args.selection as unknown as never,
        p_entity_type: args.entityType ?? "product",
        p_branch_id: currentBranch?.id ?? null,
        p_warehouse_id: args.warehouseId ?? null,
        p_copies: args.copies ?? 1,
        p_name: args.name ?? null,
      });
      if (error) throw error;
      const runId = String(data);
      await kickRun(runId);
      return runId;
    },
    onSuccess: () => {
      toast.success("Label run submitted", {
        description: "The engine is expanding and printing it. You can close this page.",
      });
      invalidate();
    },
    onError: (e: unknown) => {
      toast.error("Could not start the label run", {
        description: e instanceof Error ? e.message : "Unexpected error",
      });
    },
  });

  const setStatus = useMutation({
    mutationFn: async (args: { runId: string; status: "paused" | "running" | "cancelled" }) => {
      const { error } = await supabase.rpc("set_label_run_status", {
        p_run_id: args.runId,
        p_status: args.status,
      });
      if (error) throw error;
      if (args.status === "running") await kickRun(args.runId);
    },
    onSuccess: invalidate,
    onError: (e: unknown) =>
      toast.error(e instanceof Error ? e.message : "Could not update the run"),
  });

  const retryFailures = useMutation({
    mutationFn: async (runId: string) => {
      const { data, error } = await supabase.rpc("retry_label_run_failures", { p_run_id: runId });
      if (error) throw error;
      await kickRun(runId);
      return Number(data ?? 0);
    },
    onSuccess: (n) => {
      toast.success(n > 0 ? `Requeued ${n} failed label${n === 1 ? "" : "s"}` : "Nothing to retry");
      invalidate();
    },
    onError: (e: unknown) =>
      toast.error(e instanceof Error ? e.message : "Could not retry the run"),
  });

  const dismissDemand = useMutation({
    mutationFn: async (ids: string[]) => {
      const { error } = await supabase
        .from("label_demand")
        .update({ status: "dismissed" })
        .in("id", ids);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Dismissed");
      invalidate();
    },
    onError: (e: unknown) =>
      toast.error(e instanceof Error ? e.message : "Could not dismiss the demand"),
  });

  /**
   * Clear finished run history. Runs are an audit object, not a log to keep
   * forever: a year of daily labelling accumulates thousands of headers and
   * millions of lines, so the operator needs a bounded, explicit purge.
   * Only completed / cancelled / failed runs are eligible — the server
   * refuses anything still in flight — and lines cascade with the header.
   */
  const purgeRuns = useMutation({
    mutationFn: async (args: { olderThanDays?: number; runIds?: string[] }) => {
      if (!businessId) throw new Error("No business selected");
      const { data, error } = await supabase.rpc("purge_label_runs", {
        p_business_id: businessId,
        p_older_than_days: args.olderThanDays ?? 0,
        p_run_ids: args.runIds ?? null,
      });
      if (error) throw error;
      return Number(data ?? 0);
    },
    onSuccess: (n) => {
      toast.success(n > 0 ? `Cleared ${n} run${n === 1 ? "" : "s"}` : "Nothing to clear");
      invalidate();
    },
    onError: (e: unknown) =>
      toast.error(e instanceof Error ? e.message : "Could not clear the run history"),
  });

  return { createRun, setStatus, retryFailures, dismissDemand, purgeRuns };
}

/* ------------------------------------------------------------------ *
 * Run health — the same SLO signals the nightly monitor alerts on,
 * shown to the operator who can actually act on them.
 *
 * Thresholds are duplicated from `check-print-queue-slo` on purpose:
 * the edge function is the alerting authority, this is the read-only
 * mirror of it. Keep the two in step when tuning.
 * ------------------------------------------------------------------ */
export const LABEL_SLO = {
  runStallMinutes: 15,
  refusedRatioThreshold: 0.2,
  demandAgeHours: 24,
  demandMinCount: 25,
  minSampleSize: 20,
} as const;

export interface LabelRunHealth {
  stalledRuns: number;
  refusedLines: number;
  totalLines: number;
  refusedRatio: number;
  refusalBreach: boolean;
  agingDemand: number;
  agingBreach: boolean;
  healthy: boolean;
}

export function useLabelRunHealth(businessId?: string | null) {
  return useQuery({
    queryKey: ["label-run-health", businessId],
    enabled: !!businessId,
    refetchInterval: 30_000,
    queryFn: async (): Promise<LabelRunHealth> => {
      const now = Date.now();
      const runStallCutoff = new Date(now - LABEL_SLO.runStallMinutes * 60_000).toISOString();
      const window24h = new Date(now - 24 * 3_600_000).toISOString();
      const demandCutoff = new Date(now - LABEL_SLO.demandAgeHours * 3_600_000).toISOString();

      const [stalled, recent, aging] = await Promise.all([
        supabase
          .from("label_print_runs")
          .select("id", { count: "exact", head: true })
          .eq("business_id", businessId!)
          .in("status", ["expanding", "running"])
          .lt("updated_at", runStallCutoff),
        supabase
          .from("label_print_runs")
          .select("total_lines, refused_lines")
          .eq("business_id", businessId!)
          .gte("created_at", window24h)
          .limit(500),
        supabase
          .from("label_demand")
          .select("id", { count: "exact", head: true })
          .eq("business_id", businessId!)
          .eq("status", "open")
          .lt("created_at", demandCutoff),
      ]);

      if (stalled.error) throw stalled.error;
      if (recent.error) throw recent.error;
      if (aging.error) throw aging.error;

      let totalLines = 0;
      let refusedLines = 0;
      for (const r of (recent.data ?? []) as { total_lines: number | null; refused_lines: number | null }[]) {
        totalLines += r.total_lines ?? 0;
        refusedLines += r.refused_lines ?? 0;
      }
      const refusedRatio = totalLines > 0 ? refusedLines / totalLines : 0;

      const stalledRuns = stalled.count ?? 0;
      const agingDemand = aging.count ?? 0;
      const refusalBreach =
        totalLines >= LABEL_SLO.minSampleSize && refusedRatio >= LABEL_SLO.refusedRatioThreshold;
      const agingBreach = agingDemand >= LABEL_SLO.demandMinCount;

      return {
        stalledRuns,
        refusedLines,
        totalLines,
        refusedRatio,
        refusalBreach,
        agingDemand,
        agingBreach,
        healthy: stalledRuns === 0 && !refusalBreach && !agingBreach,
      };
    },
  });
}
