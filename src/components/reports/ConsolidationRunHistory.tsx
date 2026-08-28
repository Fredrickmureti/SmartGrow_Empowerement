/**
 * Consolidation run history and run viewer (Brick 8, step 8.4).
 *
 * A run is the reporting record: what the group reported for a period, on what
 * FX basis, over which member scope. This component reads runs and their
 * stored detail back from `consolidation_run*` ONLY — it never calls the live
 * consolidation engine and never does arithmetic. The statements beside it
 * remain the "live" view and are labelled as such by the page.
 */
import { useMemo, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ReportTable, type ReportColumn, type ReportRow } from "@/design-system/reports";
import { AlertTriangle, History, Lock, Save } from "lucide-react";
import { toast } from "sonner";
import { format } from "date-fns";
import {
  CONSOLIDATION_RUN_STATE_LABELS,
  useConsolidationRunDetail,
  useConsolidationRuns,
  useCreateConsolidationRun,
  useFinalizeConsolidationRun,
  type ConsolidationRun,
  type ConsolidationRunContribution,
} from "@/hooks/finance/useConsolidationRuns";

function money(value: number, currency: string) {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(
      Number(value),
    );
  } catch {
    return `${currency} ${Number(value).toFixed(2)}`;
  }
}

function stateVariant(state: ConsolidationRun["state"]) {
  if (state === "final") return "default" as const;
  if (state === "superseded") return "outline" as const;
  return "secondary" as const;
}

const RUN_LINE_COLUMNS: ReportColumn[] = [
  { key: "code", header: "Account" },
  { key: "name", header: "Description" },
  { key: "aggregated", header: "Aggregated", align: "right" },
  { key: "elimination", header: "Eliminations", align: "right" },
  { key: "consolidated", header: "Consolidated", align: "right" },
];

interface Props {
  groupId: string | null;
  groupName: string;
  dateFrom: string;
  dateTo: string;
  /** Runs can only be created when the live scope resolves cleanly. */
  canCreate: boolean;
}

export function ConsolidationRunHistory({
  groupId,
  groupName,
  dateFrom,
  dateTo,
  canCreate,
}: Props) {
  const runsQuery = useConsolidationRuns(groupId);
  const createRun = useCreateConsolidationRun();
  const finalizeRun = useFinalizeConsolidationRun();
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const [contributions, setContributions] = useState<{
    label: string;
    rows: ConsolidationRunContribution[];
  } | null>(null);

  const runs = runsQuery.data ?? [];
  const openRun = useMemo(
    () => runs.find((r) => r.id === openRunId) ?? null,
    [runs, openRunId],
  );
  const detailQuery = useConsolidationRunDetail(openRunId);

  const handleCreate = async () => {
    if (!groupId) return;
    try {
      const id = await createRun.mutateAsync({ groupId, dateFrom, dateTo });
      setOpenRunId(id);
      toast.success("Consolidation run saved as a draft");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "The run could not be created");
    }
  };

  const handleFinalize = async (runId: string) => {
    if (!groupId) return;
    try {
      await finalizeRun.mutateAsync({ runId, groupId });
      toast.success("Run finalized — these are now the reported figures");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "The run could not be finalized");
    }
  };

  // The stored contributions never travel inside a report row (they are not
  // cell values); the row id keys back into them for the drill-down.
  const contributionsByLine = useMemo(() => {
    const map = new Map<string, { label: string; rows: ConsolidationRunContribution[] }>();
    for (const l of detailQuery.data?.lines ?? []) {
      map.set(l.id, {
        label: `${l.account_code ?? ""} ${l.account_name}`.trim(),
        rows: l.member_contributions ?? [],
      });
    }
    return map;
  }, [detailQuery.data]);

  const detailRows: ReportRow[] = useMemo(() => {
    const lines = detailQuery.data?.lines ?? [];
    const currency = openRun?.presentation_currency ?? "USD";
    return lines.map((l) => ({
      id: l.id,
      values: {
        code: l.account_code ?? "—",
        name: l.account_name,
        aggregated: money(l.aggregated_amount, currency),
        elimination:
          Number(l.elimination_amount) === 0 ? "—" : money(l.elimination_amount, currency),
        consolidated: money(l.consolidated_amount, currency),
      },
    }));
  }, [detailQuery.data, openRun?.presentation_currency]);

  const columns: ReportColumn[] = useMemo(
    () =>
      RUN_LINE_COLUMNS.map((c) =>
        c.key === "aggregated"
          ? {
              ...c,
              render: (row) => {
                const entry = contributionsByLine.get(row.id);
                const text = String(row.values?.aggregated ?? "");
                if (!entry?.rows.length) return <span className="tabular-nums">{text}</span>;
                return (
                  <button
                    type="button"
                    title="See the companies frozen behind this figure"
                    className="tabular-nums underline underline-offset-2 hover:text-primary"
                    onClick={() => setContributions(entry)}
                  >
                    {text}
                  </button>
                );
              },
            }
          : c,
      ),
    [contributionsByLine],
  );

  if (!groupId) return null;

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div className="space-y-1.5">
          <CardTitle className="text-base flex items-center gap-2">
            <History className="h-4 w-4" />
            Reported runs
          </CardTitle>
          <CardDescription>
            The statements above are the <strong>live</strong> view and move as the
            ledgers move. Saving a run freezes these figures, the member scope and the
            exchange rates used, so the period can be re-explained later.
          </CardDescription>
        </div>
        <Button size="sm" onClick={handleCreate} disabled={!canCreate || createRun.isPending}>
          <Save className="h-4 w-4 mr-2" />
          {createRun.isPending ? "Saving…" : "Save this period as a run"}
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {runsQuery.isLoading ? (
          <Skeleton className="h-20 w-full" />
        ) : runsQuery.error ? (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              {runsQuery.error instanceof Error
                ? runsQuery.error.message
                : "The run history could not be read."}
            </AlertDescription>
          </Alert>
        ) : runs.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No runs have been saved for {groupName}. Nothing is lost — the live figures
            remain available — but there is no record of what was reported.
          </p>
        ) : (
          <ul className="divide-y">
            {runs.map((run) => (
              <li
                key={run.id}
                className="py-3 flex flex-wrap items-center justify-between gap-3"
              >
                <div className="space-y-0.5">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    {run.period_start} → {run.period_end}
                    <Badge variant={stateVariant(run.state)}>
                      {CONSOLIDATION_RUN_STATE_LABELS[run.state]}
                    </Badge>
                    {!run.is_balanced && (
                      <Badge variant="destructive">Eliminations out of balance</Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {run.presentation_currency} · {run.line_count} lines ·{" "}
                    {run.member_count} companies · saved{" "}
                    {format(new Date(run.created_at), "d MMM yyyy HH:mm")}
                    {run.finalized_at
                      ? ` · finalized ${format(new Date(run.finalized_at), "d MMM yyyy HH:mm")}`
                      : ""}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" onClick={() => setOpenRunId(run.id)}>
                    View run
                  </Button>
                  {run.state === "draft" && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => handleFinalize(run.id)}
                      disabled={finalizeRun.isPending}
                    >
                      <Lock className="h-4 w-4 mr-2" />
                      Finalize
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      {/* Run viewer — reads stored lines, member scope and FX basis only. */}
      <Dialog open={!!openRunId} onOpenChange={(next) => !next && setOpenRunId(null)}>
        <DialogContent className="max-w-5xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {groupName} — {openRun?.period_start} to {openRun?.period_end}
            </DialogTitle>
            <DialogDescription>
              {openRun
                ? `${CONSOLIDATION_RUN_STATE_LABELS[openRun.state]} run, presented in ${
                    openRun.presentation_currency
                  }, saved ${format(new Date(openRun.created_at), "d MMM yyyy HH:mm")}. These figures are read from storage, not recalculated.`
                : ""}
            </DialogDescription>
          </DialogHeader>

          {detailQuery.isLoading ? (
            <Skeleton className="h-64 w-full" />
          ) : (
            <div className="space-y-6">
              <ReportTable
                columns={columns}
                rows={detailRows}
                caption="Statement lines as reported by this run"
                emptyMessage="This run stored no statement lines"
              />

              <div>
                <h3 className="text-sm font-semibold mb-2">
                  Exchange rate basis frozen by this run
                </h3>
                {(detailQuery.data?.rates ?? []).length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No translation was required: every member reports in the group's
                    presentation currency.
                  </p>
                ) : (
                  <ul className="text-sm space-y-1">
                    {(detailQuery.data?.rates ?? []).map((r) => {
                      const member = (detailQuery.data?.members ?? []).find(
                        (m) => m.business_id === r.business_id,
                      );
                      return (
                        <li key={r.id} className="tabular-nums">
                          {member?.business_name ?? r.business_id}: {r.from_currency} →{" "}
                          {r.to_currency} · closing {r.closing_rate ?? "—"} · average{" "}
                          {r.average_rate ?? "—"} · historical {r.historical_rate ?? "—"}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>

              <div>
                <h3 className="text-sm font-semibold mb-2">Member scope as resolved</h3>
                <ul className="text-sm space-y-1">
                  {(detailQuery.data?.members ?? []).map((m) => (
                    <li key={m.id}>
                      {m.business_name} ({m.base_currency}) ·{" "}
                      {m.is_parent ? "parent" : m.method} · {m.ownership_percent}%
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Drill-down against the stored contributions, never a recomputation. */}
      <Dialog
        open={!!contributions}
        onOpenChange={(next) => !next && setContributions(null)}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{contributions?.label}</DialogTitle>
            <DialogDescription>
              The member companies behind this figure, as frozen by the run.
            </DialogDescription>
          </DialogHeader>
          <ul className="text-sm space-y-1">
            {(contributions?.rows ?? []).map((c) => (
              <li key={c.business_id} className="tabular-nums">
                {c.business_name} ({c.base_currency}) · {c.closing_balance} ×{" "}
                {c.rate_used ?? 1} ({c.rate_class ?? "no translation"}) ={" "}
                {money(c.translated_closing, openRun?.presentation_currency ?? "USD")}
              </li>
            ))}
          </ul>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
