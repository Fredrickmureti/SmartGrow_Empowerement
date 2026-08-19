import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, FileWarning, History, Loader2, RefreshCw, Wrench } from "lucide-react";
import { useState } from "react";
import { format } from "date-fns";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { PermissionGate } from "@/components/common/PermissionGate";
import {
  useInventoryDriftExplanation,
  useInventoryReconciliation,
  useInventorySubledgerComposition,
  useNegativeStockPositions,
} from "@/hooks/finance/useInventoryReconciliation";
import { OpeningInventoryBackfillDialog } from "./OpeningInventoryBackfillDialog";
import {
  useAdjustmentBackfillHistory,
  useBackfillAdjustmentJE,
  useMissingAdjustmentJournals,
} from "@/hooks/useInventory";

const fmt = (n: number) =>
  new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n ?? 0);

const qty = (n: number) =>
  new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 }).format(n ?? 0);

export interface InventoryReconciliationCardProps {
  /** Reconcile as at this date (ISO). Defaults to today. */
  asOf?: string;
}

export function InventoryReconciliationCard({ asOf }: InventoryReconciliationCardProps = {}) {
  const { data: rows = [], isLoading, refetch, isFetching } = useInventoryReconciliation(asOf);
  const [showNegative, setShowNegative] = useState(false);
  const [showComposition, setShowComposition] = useState(false);
  const [backfillOpen, setBackfillOpen] = useState(false);

  const hasDrift = rows.some((r) => Math.abs(r.drift) > 0.01);
  const dataQuality = rows.reduce(
    (acc, r) => ({
      fallback: acc.fallback + (r.unlayered_positions ?? 0),
      zero: acc.zero + (r.zero_cost_positions ?? 0),
      negative: acc.negative + (r.negative_qty_positions ?? 0),
    }),
    { fallback: 0, zero: 0, negative: 0 },
  );

  const negative = useNegativeStockPositions(showNegative);
  const composition = useInventorySubledgerComposition(showComposition, asOf);
  const explanation = useInventoryDriftExplanation(asOf, hasDrift);

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1 min-w-0">
            <CardTitle className="flex items-center gap-2 text-base">
              <Wrench className="h-4 w-4" />
              Inventory subledger ↔ General Ledger
              {hasDrift ? (
                <Badge variant="destructive">Drift</Badge>
              ) : (
                <Badge variant="outline">Reconciled</Badge>
              )}
            </CardTitle>
            <CardDescription className="text-xs">
              Stock on hand valued from the cost-layer ledger as at the reporting date, compared
              against the posted GL closing balance of the Inventory control account
              {asOf ? ` as at ${asOf}` : ""}. A non-zero drift means a journal is missing,
              mis-dated, or posted to the wrong account.
            </CardDescription>
          </div>
          <div className="flex gap-2 shrink-0 flex-wrap">
            <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
              {isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Recheck
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowNegative((v) => !v)}
            >
              {showNegative ? "Hide negative stock" : "Scan negative stock"}
            </Button>
            <PermissionGate permission="manageFinancials">
              <Button size="sm" onClick={() => setBackfillOpen(true)} disabled={!hasDrift}>
                Post opening inventory
              </Button>
            </PermissionGate>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? (
          <div className="flex justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : rows.length === 0 ? (
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              Inventory default account is not configured for this organization. Set it under
              Default Accounts before reconciling.
            </AlertDescription>
          </Alert>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  <th className="py-2 pr-4">Account</th>
                  <th className="py-2 pr-4 text-right">Subledger (at cost)</th>
                  <th className="py-2 pr-4 text-right">GL closing</th>
                  <th className="py-2 pr-4 text-right">Drift</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.account_id} className="border-t">
                    <td className="py-2 pr-4">
                      <div className="font-medium">{r.account_name}</div>
                      <div className="text-xs text-muted-foreground">{r.account_code}</div>
                    </td>
                    <td className="py-2 pr-4 text-right tabular-nums">{fmt(r.subledger_value)}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">{fmt(r.gl_closing)}</td>
                    <td
                      className={
                        "py-2 pr-4 text-right tabular-nums " +
                        (Math.abs(r.drift) > 0.01 ? "text-destructive font-semibold" : "")
                      }
                    >
                      {fmt(r.drift)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {!hasDrift && rows.length > 0 && (
          <Alert className="border-primary/30 bg-primary/5">
            <CheckCircle2 className="h-4 w-4 text-primary" />
            <AlertDescription className="text-foreground">
              Inventory subledger and GL agree. No remediation needed.
            </AlertDescription>
          </Alert>
        )}

        {/* Valuation-basis transparency: an agreeing total built on guessed
            costs is not a clean reconciliation, so say so either way. */}
        {rows.length > 0 && (dataQuality.fallback > 0 || dataQuality.zero > 0 || dataQuality.negative > 0) && (
          <Alert variant={dataQuality.zero > 0 || dataQuality.negative > 0 ? "destructive" : "default"}>
            <FileWarning className="h-4 w-4" />
            <AlertDescription className="text-xs space-y-1">
              <div className="font-medium">Valuation basis exceptions</div>
              <ul className="list-disc pl-4">
                {dataQuality.fallback > 0 && (
                  <li>
                    {dataQuality.fallback} position(s) hold quantity with no cost layer, so the
                    layer ledger cannot value them.
                  </li>
                )}
                {dataQuality.zero > 0 && (
                  <li>{dataQuality.zero} position(s) have stock but zero cost — understating the subledger.</li>
                )}
                {dataQuality.negative > 0 && (
                  <li>{dataQuality.negative} position(s) hold negative quantity — impossible on hand.</li>
                )}
              </ul>
            </AlertDescription>
          </Alert>
        )}

        {/* Difference explained — an audit report must attribute drift, not
            just report it. */}
        {hasDrift && (
          <div className="rounded-md border p-3 space-y-2">
            <div className="text-sm font-semibold">Difference explained</div>
            {explanation.isLoading ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" /> Attributing drift…
              </div>
            ) : !explanation.data ? (
              <p className="text-xs text-muted-foreground italic">No attribution available.</p>
            ) : (
              <table className="w-full text-sm">
                <tbody>
                  {(explanation.data.components ?? []).map((c) => (
                    <tr key={c.code} className="border-t">
                      <td className="py-1.5 pr-4">
                        {c.label}
                        {c.count != null ? (
                          <span className="text-xs text-muted-foreground"> ({c.count})</span>
                        ) : null}
                      </td>
                      <td className="py-1.5 text-right tabular-nums">{fmt(c.amount)}</td>
                    </tr>
                  ))}
                  <tr className="border-t font-semibold">
                    <td className="py-1.5 pr-4">Unexplained residual</td>
                    <td className="py-1.5 text-right tabular-nums">
                      {fmt(explanation.data.unexplained)}
                    </td>
                  </tr>
                </tbody>
              </table>
            )}
          </div>
        )}

        {/* Negative stock — read-only detection. Never writes findings. */}
        {showNegative && (
          <div className="rounded-md border p-3 space-y-2">
            <div className="text-sm font-semibold">Negative stock positions</div>
            <p className="text-xs text-muted-foreground">
              An operational defect: negative quantity has no cost layers, so the
              amounts below are average-cost exposure estimates, not accounting
              valuations.
            </p>
            {negative.isLoading ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" /> Scanning…
              </div>
            ) : (negative.data ?? []).length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No negative stock positions found. Nothing to remediate.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-muted-foreground">
                      <th className="py-1.5 pr-4">Product</th>
                      <th className="py-1.5 pr-4">Warehouse</th>
                      <th className="py-1.5 pr-4 text-right">Qty</th>
                      <th className="py-1.5 pr-4 text-right">AVCO unit cost</th>
                      <th className="py-1.5 text-right">AVCO exposure (est.)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(negative.data ?? []).map((n) => (
                      <tr key={`${n.product_id}-${n.warehouse_id}`} className="border-t">
                        <td className="py-1.5 pr-4">
                          <div className="font-medium">{n.product_name}</div>
                          <div className="text-xs text-muted-foreground">{n.sku}</div>
                        </td>
                        <td className="py-1.5 pr-4">{n.warehouse_name ?? "—"}</td>
                        <td className="py-1.5 pr-4 text-right tabular-nums text-destructive">
                          {qty(n.quantity)}
                        </td>
                        <td className="py-1.5 pr-4 text-right tabular-nums">
                          {fmt(n.avco_unit_cost)}
                        </td>
                        <td className="py-1.5 text-right tabular-nums">
                          {fmt(n.avco_exposure_estimate)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* Subledger composition — defends the subledger figure line by line. */}
        {rows.length > 0 && (
          <div className="rounded-md border p-3 space-y-2">
            <button
              type="button"
              className="flex items-center gap-2 text-sm font-semibold"
              onClick={() => setShowComposition((v) => !v)}
              aria-expanded={showComposition}
            >
              {showComposition ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronRight className="h-4 w-4" />
              )}
              Subledger composition
            </button>
            {showComposition ? (
              composition.isLoading ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" /> Loading positions…
                </div>
              ) : (
                <>
                  <p className="text-xs text-muted-foreground">
                    Valued from the cost-layer ledger as at the reporting date — the
                    same basis as the Inventory Valuation report. Positions with
                    quantity but no cost layer are listed at zero and flagged.
                  </p>
                  <div className="overflow-x-auto max-h-80 overflow-y-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-xs text-muted-foreground">
                          <th className="py-1.5 pr-4">Product</th>
                          <th className="py-1.5 pr-4">Warehouse</th>
                          <th className="py-1.5 pr-4 text-right">Qty</th>
                          <th className="py-1.5 pr-4 text-right">Unit cost</th>
                          <th className="py-1.5 pr-4">Basis</th>
                          <th className="py-1.5 text-right">Value</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(composition.data ?? []).map((c) => (
                          <tr key={`${c.product_id}-${c.warehouse_id}`} className="border-t">
                            <td className="py-1.5 pr-4">
                              <div className="font-medium">{c.product_name}</div>
                              <div className="text-xs text-muted-foreground">{c.sku}</div>
                            </td>
                            <td className="py-1.5 pr-4">{c.warehouse_name ?? "—"}</td>
                            <td className="py-1.5 pr-4 text-right tabular-nums">{qty(c.quantity)}</td>
                            <td className="py-1.5 pr-4 text-right tabular-nums">{fmt(c.unit_cost)}</td>
                            <td className="py-1.5 pr-4">
                              <Badge
                                variant={
                                  c.cost_basis === "cost_layer" ? "outline" : "secondary"
                                }
                              >
                                {COST_BASIS_LABEL[c.cost_basis] ?? c.cost_basis}
                              </Badge>
                            </td>
                            <td className="py-1.5 text-right tabular-nums">{fmt(c.value)}</td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr className="border-t font-semibold">
                          <td className="py-1.5 pr-4" colSpan={5}>
                            Listed positions
                          </td>
                          <td className="py-1.5 text-right tabular-nums">
                            {fmt(
                              (composition.data ?? []).reduce(
                                (s, c) => s + (c.value ?? 0),
                                0,
                              ),
                            )}
                          </td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                </>
              )
            ) : null}
          </div>
        )}

        <MissingAdjustmentJournalsSection />
      </CardContent>

      <OpeningInventoryBackfillDialog
        open={backfillOpen}
        onOpenChange={setBackfillOpen}
        asOf={asOf}
      />
    </Card>
  );
}


/**
 * G10 — surfaces approved stock adjustments that have NO journal entry
 * (legacy data from before the Phase A+B fix). Per-row "Post JE now" calls
 * `backfill_missing_adjustment_je`. Strictly opt-in — no bulk button.
 */
function MissingAdjustmentJournalsSection() {
  const { data: rows = [], isLoading, refetch, isFetching } = useMissingAdjustmentJournals();
  const backfill = useBackfillAdjustmentJE();

  if (isLoading) return null;
  if (rows.length === 0) return null;

  return (
    <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2 min-w-0">
          <FileWarning className="h-4 w-4 mt-0.5 text-destructive shrink-0" />
          <div className="min-w-0">
            <div className="text-sm font-medium">
              {rows.length} approved adjustment{rows.length === 1 ? "" : "s"} missing a journal entry
            </div>
            <p className="text-xs text-muted-foreground">
              These rows moved stock but never posted to the GL. Review each one
              and post the journal entry individually. Posting uses today&apos;s
              date and today&apos;s resolved cost — not the original adjustment date.
            </p>
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => refetch()}
          disabled={isFetching}
        >
          {isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
        </Button>
      </div>
      <ul className="divide-y rounded border bg-background">
        {rows.map((row) => (
          <MissingJournalRow
            key={row.id}
            row={row}
            isBackfilling={backfill.isPending}
            onBackfill={() => backfill.mutate(row.id)}
          />
        ))}
      </ul>
    </div>
  );
}

interface MissingJournalRowProps {
  row: { id: string; adjustment_number: string; adjustment_date: string; reason: string };
  isBackfilling: boolean;
  onBackfill: () => void;
}

/**
 * Wave 6 — collapsible "Backfill history" disclosure per row. Lists every
 * past backfill attempt recorded in `stock_adjustment_backfill_log` so
 * finance can trace exactly when/who posted today's-cost JE for a legacy
 * adjustment that originally bypassed the GL.
 */
function MissingJournalRow({ row, isBackfilling, onBackfill }: MissingJournalRowProps) {
  const [open, setOpen] = useState(false);
  const { data: history = [], isLoading: historyLoading } = useAdjustmentBackfillHistory(row.id, open);

  return (
    <li className="text-sm">
      <div className="flex items-center justify-between gap-3 px-3 py-2">
        <button
          type="button"
          className="flex items-start gap-2 min-w-0 text-left flex-1 hover:underline"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          {open ? (
            <ChevronDown className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
          ) : (
            <ChevronRight className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
          )}
          <div className="min-w-0">
            <div className="font-medium truncate">{row.adjustment_number}</div>
            <div className="text-xs text-muted-foreground">
              {format(new Date(row.adjustment_date), "MMM d, yyyy")} · {row.reason}
            </div>
          </div>
        </button>
        <PermissionGate permission="manageFinancials">
          <Button
            size="sm"
            variant="outline"
            onClick={onBackfill}
            disabled={isBackfilling}
          >
            {isBackfilling ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : null}
            Post JE now
          </Button>
        </PermissionGate>
      </div>
      {open ? (
        <div className="bg-muted/30 border-t px-3 py-2">
          <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground mb-2">
            <History className="h-3.5 w-3.5" />
            Backfill history
          </div>
          {historyLoading ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground py-1">
              <Loader2 className="h-3 w-3 animate-spin" /> Loading…
            </div>
          ) : history.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">
              No backfill has been posted for this adjustment yet.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {history.map((h) => (
                <li
                  key={h.id}
                  className="text-xs grid grid-cols-1 md:grid-cols-[auto_1fr_auto] gap-x-3 gap-y-0.5"
                >
                  <span className="font-medium tabular-nums">
                    {format(new Date(h.posted_at), "MMM d, yyyy HH:mm")}
                  </span>
                  <span className="text-muted-foreground truncate">
                    {h.posted_by_name ?? "system"}
                    {h.note ? ` · ${h.note}` : ""}
                  </span>
                  <span className="tabular-nums font-medium">
                    {new Intl.NumberFormat(undefined, {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    }).format(h.total_value ?? 0)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </li>
  );
}
