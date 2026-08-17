/**
 * CountReview — supervisor review + submit surface for a
 * `wms_count_session`.
 *
 * Submitting delegates to `post_count_session`, which hands the counted
 * result to the canonical Inventory count document. Inventory — not the
 * warehouse — evaluates tolerance, takes approval and posts the stock
 * adjustment and its journal entry. The client never touches
 * `stock_quants`.
 *
 * Every non-zero difference must carry a reason code before the session
 * can be submitted; the server rejects submission otherwise, and this
 * screen collects the codes so operators never meet that error blind.
 */
import { useMemo } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { usePostCountSession } from "@/features/warehouse/aggregates/useDomainOperations";
import { replayGuardedCall } from "@/features/warehouse/scanning/replayGuardedCall";
import { PageHeader, PageBody, Section, LoadingState, EmptyState, StatusBadge } from "@/design-system";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ArrowLeft, CheckCircle2, ClipboardCheck, RotateCcw } from "lucide-react";
import { CancelAggregateButton } from "@/features/warehouse/aggregates/CancelAggregateButton";
import { useCountLines, countLineProductLabel, countLineEnteredLabel, countLineAwaitsApproval } from "@/features/warehouse/counts/useCountLines";
import { useWarehouseQtyFormatter, WarehouseQty } from "@/features/warehouse/quantity/warehouseQty";
import { useProductBaseUomLabels } from "@/features/warehouse/quantity/useProductBaseUomLabels";

import { useRequestRecount } from "@/features/warehouse/counts/useRequestRecount";
import { CountDocumentsMenu } from "@/features/warehouse/counts/CountDocumentsMenu";

import {
  VARIANCE_REASONS,
  TOLERANCE_COPY,
  type ToleranceOutcome,
  type VarianceReason,
} from "@/features/warehouse/counts/varianceReasons";


export default function CountReview() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const nav = useNavigate();
  const queryClient = useQueryClient();

  const { data: session, isLoading } = useQuery({
    queryKey: ["wms-count-session", sessionId],
    enabled: !!sessionId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_count_sessions")
        .select("id, code, state, row_version, posted_at, is_blind")
        .eq("id", sessionId!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const { data: lines } = useCountLines(sessionId);

  // Phase 2.4 — unit truth: pack rollups and the product's own base UoM label.
  const lineProductIds = useMemo(() => (lines ?? []).map((l) => l.product_id), [lines]);
  const qtyBaseLabels = useProductBaseUomLabels(lineProductIds);
  const qtyFmt = useWarehouseQtyFormatter(lineProductIds, qtyBaseLabels);


  const setReason = useMutation({
    mutationFn: async (v: { line_id: string; counted_qty: number; reason: VarianceReason }) => {
      await replayGuardedCall("record_count", {
        p_line_id: v.line_id,
        p_counted_qty: v.counted_qty,
        p_variance_reason: v.reason,
      });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["wms-count-lines", sessionId] }),
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Could not save the reason"),
  });

  const recount = useRequestRecount(sessionId);
  const post = usePostCountSession(sessionId);

  const handlePost = () =>
    post.mutate(undefined, {
      onSuccess: () => {
        toast.success("Count submitted to Inventory for approval and posting");
        nav("/warehouse-app/counts");
      },
    });

  if (isLoading) return <LoadingState />;
  if (!session) {
    return (
      <EmptyState
        icon={ClipboardCheck}
        title="Session not found"
        action={<Button asChild><Link to="/warehouse-app/counts">Back</Link></Button>}
      />
    );
  }

  const all = lines ?? [];
  // A flagged attempt stops blocking once a newer round supersedes it —
  // the same rule `post_count_session` applies server-side.
  const superseded = new Set(all.map((l) => l.recount_of_line_id).filter(Boolean) as string[]);
  const isLatest = (id: string) => !superseded.has(id);
  const variances = all.filter(
    (l) => isLatest(l.id) && l.counted_qty != null && Number(l.variance_qty ?? 0) !== 0,
  );
  const uncounted = all.filter((l) => isLatest(l.id) && l.counted_qty == null);
  const missingReasons = variances.filter((l) => !l.variance_reason);
  const openRecounts = all.filter(
    (l) => l.tolerance_outcome === "recount_required" && isLatest(l.id) && (l.approval_state ?? "pending") === "pending",
  );
  // Only lines whose Inventory decision is still outstanding are pending.
  const needsApproval = all.filter((l) => countLineAwaitsApproval(l) && isLatest(l.id));
  const resolvedApprovals = all.filter((l) => isLatest(l.id) && l.approval_state === "approved");


  const canPost =
    session.state !== "posted" &&
    session.state !== "cancelled" &&
    missingReasons.length === 0 &&
    openRecounts.length === 0;

  return (
    <>
      <PageHeader
        title={<span className="font-mono">{session.code} — review</span>}
        description={<>State: <StatusBadge tone={session.state === "posted" ? "success" : "info"}>{session.state}</StatusBadge></>}
        actions={
          <div className="flex gap-2">
            <Button variant="outline" asChild>
              <Link to={`/warehouse-app/counts/${sessionId}`}><ArrowLeft className="h-4 w-4 mr-2" /> Back to counting</Link>
            </Button>
            {/* ADR 0106 — supervisor paperwork: the sheet, the difference
              * report and the full attempt-by-attempt audit report. */}
            <CountDocumentsMenu sessionId={session.id} countNumber={session.code} isBlind={session.is_blind === true} />

            <CancelAggregateButton
              aggregate="count"
              id={session.id}
              rowVersion={session.row_version}
              state={session.state}
              size="default"
              variant="outline"
              onCancelled={() => {
                queryClient.invalidateQueries({ queryKey: ["wms-count-session", sessionId] });
                nav("/warehouse-app/counts");
              }}
            />
            <Button disabled={!canPost || post.isPending} onClick={handlePost}>
              <CheckCircle2 className="h-4 w-4 mr-2" /> Submit {variances.length} difference{variances.length === 1 ? "" : "s"}
            </Button>
          </div>
        }
      />
      <PageBody>
        <p className="text-sm text-muted-foreground -mt-2">
          Submitting hands this count to Inventory. Stock and the ledger are only updated once the
          count is approved there — the warehouse never changes stock on its own.
        </p>

        {/* At-a-glance result. The whole point is that a supervisor can judge
          * the count on screen without downloading a single document. */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {[
            { label: "Bins in scope", value: all.filter((l) => isLatest(l.id)).length },
            { label: "Counted", value: all.filter((l) => isLatest(l.id) && l.counted_qty != null).length },
            { label: "Not counted", value: uncounted.length },
            { label: "Differences", value: variances.length },
            {
              label: "Units over",
              value: variances.reduce((s, l) => s + Math.max(0, Number(l.variance_qty ?? 0)), 0),
            },
            {
              label: "Units short",
              value: Math.abs(
                variances.reduce((s, l) => s + Math.min(0, Number(l.variance_qty ?? 0)), 0),
              ),
            },
          ].map((stat) => (
            <div key={stat.label} className="rounded-md border border-border bg-card p-3">
              <div className="text-xs text-muted-foreground">{stat.label}</div>
              <div className="text-xl font-semibold tabular-nums">{stat.value}</div>
            </div>
          ))}
        </div>

        {openRecounts.length > 0 && (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm space-y-2">
            <p>
              {openRecounts.length} line{openRecounts.length === 1 ? "" : "s"} fell outside the
              allowed difference and must be counted again. Submission stays locked until a second
              round is opened and recorded.
            </p>
            <div className="space-y-1">
              {openRecounts.map((l) => (
                <div key={l.id} className="flex items-center justify-between gap-2">
                  <span>
                    <span className="font-mono">{l.location_code ?? "—"}</span>{" "}
                    · {countLineProductLabel(l)}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={recount.isPending || session.state === "posted"}
                    onClick={() => recount.mutate({ line_id: l.id })}
                  >
                    <RotateCcw className="h-3.5 w-3.5 mr-1.5" /> Count again
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}

        {needsApproval.length > 0 && (
          <div className="rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
            {describeCountGovernance(governance, needsApproval.length) ??
              `${needsApproval.length} line${needsApproval.length === 1 ? "" : "s"} exceed the allowed difference. Governance decides who signs this off when you submit.`}
          </div>
        )}
        {needsApproval.length === 0 && resolvedApprovals.length > 0 && session.state === "posted" && (
          <div className="rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
            Differences on this count were signed off and the stock adjustment has been posted.
            Nothing here is waiting on anyone.
          </div>
        )}

        {missingReasons.length > 0 && (
          <div className="rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
            Choose a reason for each difference below before submitting.
          </div>
        )}

        {uncounted.length > 0 && (
          <Section title={`Not counted (${uncounted.length})`} description="These lines were included in the count but never recorded. Submitting treats them as no difference.">
            <div className="text-sm text-muted-foreground">
            {uncounted.slice(0, 20).map((l) => (
              <div key={l.id}>{l.location_code ?? "—"} · {countLineProductLabel(l)}</div>
            ))}
            {uncounted.length > 20 && <div>…and {uncounted.length - 20} more</div>}
            </div>
          </Section>
        )}

        <Section title={`Differences (${variances.length})`} contentClassName="px-0 pb-0">
          {variances.length === 0 ? (
            <div className="p-4 text-sm text-muted-foreground">No differences — submitting will simply close the count.</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr className="text-left">
                  <th className="p-2">Bin</th>
                  <th className="p-2">Product</th>
                  <th className="p-2">Lot</th>
                  <th className="p-2 text-right">Expected</th>
                  <th className="p-2 text-right">Counted</th>
                  <th className="p-2 text-right">Difference</th>
                  <th className="p-2">Check</th>
                  <th className="p-2">Reason</th>
                </tr>
              </thead>
              <tbody>
                {variances.map((l) => {
                  const outcome = l.tolerance_outcome as ToleranceOutcome | null;
                  return (
                    <tr key={l.id} className="border-t">
                      <td className="p-2 font-mono">{l.location_code ?? "—"}</td>
                      <td className="p-2">{countLineProductLabel(l)}</td>
                      <td className="p-2">{l.lot_number ?? "—"}</td>
                      <td className="p-2 text-right font-mono">
                        {l.system_qty == null ? (
                          "—"
                        ) : (
                          <WarehouseQty fmt={qtyFmt} productId={l.product_id} baseQty={l.system_qty} />
                        )}
                      </td>
                      <td className="p-2 text-right font-mono">
                        <WarehouseQty fmt={qtyFmt} productId={l.product_id} baseQty={l.counted_qty} />
                        {countLineEnteredLabel(l) && (
                          <span className="block text-xs text-muted-foreground">
                            entered {countLineEnteredLabel(l)}
                          </span>
                        )}
                      </td>

                      <td className="p-2 text-right font-mono text-destructive">
                        <WarehouseQty fmt={qtyFmt} productId={l.product_id} baseQty={l.variance_qty} signed />
                      </td>

                      <td className="p-2">
                        {outcome ? (
                          <StatusBadge tone={TOLERANCE_COPY[outcome]?.tone ?? "info"}>
                            {TOLERANCE_COPY[outcome]?.label ?? outcome}
                          </StatusBadge>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="p-2">
                        <Select
                          value={l.variance_reason ?? undefined}
                          disabled={session.state === "posted" || setReason.isPending}
                          onValueChange={(value) =>
                            setReason.mutate({
                              line_id: l.id,
                              counted_qty: Number(l.counted_qty ?? 0),
                              reason: value as VarianceReason,
                            })
                          }
                        >
                          <SelectTrigger className="h-8 w-56">
                            <SelectValue placeholder="Why is it different?" />
                          </SelectTrigger>
                          <SelectContent>
                            {VARIANCE_REASONS.map((r) => (
                              <SelectItem key={r.value} value={r.value}>
                                {r.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Section>
      </PageBody>
    </>
  );
}
