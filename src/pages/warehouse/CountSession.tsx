/**
 * CountSession — captures counted quantities against a snapshotted set
 * of on-hand rows. Every record goes through `record_count` — the client
 * never writes `counted_qty` / `variance_qty` directly.
 *
 * Reads go through `get_count_lines` (never the table) so BLIND sessions
 * genuinely hide the expected quantity from the operator until review —
 * the control every enterprise WMS relies on to stop counters "counting
 * to the system figure".
 *
 * `record_count` returns a tolerance outcome per line. A line outside
 * policy is flagged for recount or supervisor approval before the
 * session can be submitted.
 */
import { useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ActivitySection } from "@/features/warehouse/events/ActivitySection";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { replayGuardedCall } from "@/features/warehouse/scanning/replayGuardedCall";
import { toast } from "sonner";
import { PageHeader, PageBody, Section, LoadingState, EmptyState, StatusBadge } from "@/design-system";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScanTextField } from "@/components/scanner/ScanTextField";
import { Label } from "@/components/ui/label";
import { ArrowLeft, ClipboardCheck, EyeOff, RotateCcw } from "lucide-react";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useProductPackagingBatch } from "@/hooks/inventory/useProductPackagingBatch";
import {
  unitOptionsFor, optionByKey, toBaseUnits, BASE_UNIT_KEY,
} from "@/features/warehouse/receiving/receivingUnits";

import { PrintLabelButton } from "@/components/labels/PrintLabelButton";
import { BarcodeInputField } from "@/components/scanner/BarcodeInputField";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranches } from "@/hooks/useBranches";
import { useResolveProductIdentity } from "@/hooks/inventory/useResolveProductIdentity";
import { identityOutcomeLine } from "@/features/products/identity/identityOutcome";
import { useCountLines, countLineProductLabel, countLineProductSubLabel } from "@/features/warehouse/counts/useCountLines";
import { useWarehouseQtyFormatter, WarehouseQty } from "@/features/warehouse/quantity/warehouseQty";
import { useProductBaseUomLabels } from "@/features/warehouse/quantity/useProductBaseUomLabels";

import { useRequestRecount } from "@/features/warehouse/counts/useRequestRecount";
import { CountDocumentsMenu } from "@/features/warehouse/counts/CountDocumentsMenu";

import { TOLERANCE_COPY, type ToleranceOutcome } from "@/features/warehouse/counts/varianceReasons";

import { useQuery } from "@tanstack/react-query";

export default function CountSession() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const nav = useNavigate();
  const qc = useQueryClient();

  const [scanBin, setScanBin] = useState("");
  const [scanProduct, setScanProduct] = useState("");
  const [countedByLine, setCountedByLine] = useState<Record<string, string>>({});
  // Phase C3 — a scanned product code is resolved to a product id through
  // the canonical resolver, so any enrolled level (each / inner / case)
  // selects the right count line instead of only an exact SKU string.
  const [scanProductId, setScanProductId] = useState<string | null>(null);
  const [scanFlash, setScanFlash] = useState<string | null>(null);
  const activeRowRef = useRef<HTMLTableRowElement | null>(null);

  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranches();
  const { resolve: resolveIdentity } = useResolveProductIdentity(
    currentBusiness?.id,
    currentBranch?.id ?? null,
  );

  const { data: session, isLoading } = useQuery({
    queryKey: ["wms-count-session", sessionId],
    enabled: !!sessionId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_count_sessions")
        .select("id, code, state, warehouse_id, strategy, is_blind")
        .eq("id", sessionId!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const { data: lines } = useCountLines(sessionId);

  // Phase 2 — counting in packaging units ("4 cases") on the desktop too.
  // The screen only carries the packaging level; `record_count` converts it
  // through `wms_to_base_qty` against the canonical Product foundation.
  const countProductIds = useMemo(
    () => Array.from(new Set((lines ?? []).map((l) => l.product_id).filter(Boolean) as string[])),
    [lines],
  );
  const { packsByProduct } = useProductPackagingBatch(countProductIds);
  const [unitByLine, setUnitByLine] = useState<Record<string, string>>({});

  // Phase 2.4 — unit truth on every rendered quantity.
  const qtyBaseLabels = useProductBaseUomLabels(countProductIds);
  const qtyFmt = useWarehouseQtyFormatter(countProductIds, qtyBaseLabels);


  // Blind while counting: the RPC returns NULL for system/variance, and we
  // stop rendering those columns entirely so nothing leaks through.
  const blind = !!session?.is_blind && session.state !== "review" && session.state !== "posted";

  const record = useMutation({
    mutationFn: async (v: { line_id: string; counted_qty: number; packaging_id: string | null }) => {
      // Phase 5.1 — replay-guarded: a double-tapped "Record" cannot post
      // the same count twice.
      const { data } = await replayGuardedCall("record_count", {
        p_line_id: v.line_id,
        // Operator-entered quantity; the server derives the base figure.
        p_counted_qty: v.counted_qty,
        p_entered_qty: v.counted_qty,
        p_packaging_id: v.packaging_id,
        p_note: null,
      });
      return data as { tolerance_outcome?: ToleranceOutcome } | null;
    },

    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["wms-count-lines", sessionId] });
      const outcome = data?.tolerance_outcome;
      if (outcome === "recount_required") {
        toast.warning("Outside tolerance — count this bin again.");
      } else if (outcome === "approval_required") {
        toast.warning("Outside tolerance — a supervisor must approve this line.");
      }
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Record failed"),
  });

  const recount = useRequestRecount(sessionId);


  const flash = (msg: string, ms = 2500) => {
    setScanFlash(msg);
    window.setTimeout(() => setScanFlash(null), ms);
  };

  const handleProductScan = async (code: string) => {
    const norm = code.trim();
    setScanProduct(norm);
    setScanProductId(null);
    if (!norm) return;
    const res = await resolveIdentity(norm);
    if (res.kind === "resolved") {
      setScanProductId(res.identity.productId);
      flash(res.identity.productName, 1500);
      return;
    }
    flash(identityOutcomeLine({
      status: res.kind,
      code: norm,
      matchCount: res.kind === "ambiguous" ? res.matchCount : undefined,
    }), 3500);
  };

  // Barcode-to-line resolver: match bin.code + resolved product identity
  // (falling back to a literal SKU match for typed input).
  const activeLineId = useMemo(() => {
    if (!scanBin || (!scanProduct && !scanProductId)) return null;
    const bin = scanBin.trim().toLowerCase();
    const line = (lines ?? []).find((l) => {
      if ((l.location_code ?? "").toLowerCase() !== bin) return false;
      if (scanProductId) return l.product_id === scanProductId;
      return (l.product_sku ?? "").toLowerCase() === scanProduct.trim().toLowerCase();
    });
    return line?.id ?? null;
  }, [lines, scanBin, scanProduct, scanProductId]);

  // A flagged attempt stops blocking once a newer round supersedes it —
  // the same rule `post_count_session` applies server-side.
  const supersededIds = new Set(
    (lines ?? []).map((l) => l.recount_of_line_id).filter(Boolean) as string[],
  );
  const openRecounts = (lines ?? []).filter(
    (l) => l.tolerance_outcome === "recount_required" && !supersededIds.has(l.id),
  );
  const recountCount = openRecounts.length;


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

  return (
    <>
      <PageHeader
        title={<span className="font-mono">{session.code}</span>}
        description={`State: ${session.state} · Strategy: ${session.strategy}`}
        actions={
          <div className="flex gap-2">
            <Button variant="outline" asChild>
              <Link to="/warehouse-app/counts"><ArrowLeft className="h-4 w-4 mr-2" /> Sessions</Link>
            </Button>
            {/* Wave 21 — cycle-count sheet header sticker (Business Event
              * → Template row `count_label`). Routes through the
              * canonical label dispatcher (ADR-0086 / ADR-0090). */}
            <PrintLabelButton
              variant="outline"
              size="default"
              label="Print count label"
              templateKey="count_label"
              workflow="generic"
              product={{
                id: session.id,
                name: `Count ${session.code}`,
                sku: session.code,
                barcode: session.code,
              }}
              sourceDocType="wms_count_session"
              sourceDocId={session.id}
              extraVars={{
                session_code: session.code,
                strategy: session.strategy ?? "",
                state: session.state ?? "",
              }}
            />
            {/* ADR 0106 — the counting screen only ever offers the sheet the
              * operator walks the aisle with. Blind sessions get the blind
              * sheet, which carries no expected quantity at all. */}
            <CountDocumentsMenu
              sessionId={session.id}
              isBlind={blind}
              only={["count_sheet"]}
            />
            <Button onClick={() => nav(`/warehouse-app/counts/${sessionId}/review`)}>
              <ClipboardCheck className="h-4 w-4 mr-2" /> Review + post
            </Button>

          </div>
        }
      />
      <PageBody>
        {blind && (
          <div className="flex items-start gap-2 rounded-md border border-border bg-muted/40 p-3 text-sm">
            <EyeOff className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
            <p className="text-muted-foreground">
              <span className="font-medium text-foreground">Blind count.</span>{" "}
              The expected quantity is hidden until the count is submitted for review, so what you
              record is what you actually see on the shelf.
            </p>
          </div>
        )}
        {recountCount > 0 && (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
            {recountCount} line{recountCount === 1 ? "" : "s"} fell outside the allowed difference and
            must be counted again before this session can be submitted.
          </div>
        )}

        <Section title="Scan">
          <div className="min-w-0 grid grid-cols-1 @2xl/page:grid-cols-2 gap-3">
            <div>
              <Label>Bin</Label>
              <ScanTextField
                placeholder="Scan or type bin code"
                cameraLabel="Scan the bin label"
                value={scanBin}
                onChange={setScanBin}
              />

            </div>
            <div>
              <Label>Product</Label>
              <BarcodeInputField
                workflow="count"
                placeholder="Scan or type product barcode / SKU"
                value={scanProduct}
                onChange={(v) => {
                  setScanProduct(v);
                  setScanProductId(null);
                }}
                onScan={handleProductScan}
              />
              {scanFlash && (
                <p className="mt-1 text-xs text-muted-foreground">{scanFlash}</p>
              )}
            </div>
          </div>
        </Section>

        <Section title="Lines" contentClassName="px-0 pb-0">
          {(lines ?? []).length === 0 ? (
            <div className="p-4 text-sm text-muted-foreground">Nothing to count in this session.</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr className="text-left">
                  <th className="p-2">Bin</th>
                  <th className="p-2">Product</th>
                  <th className="p-2">Lot</th>
                  {!blind && <th className="p-2 text-right">System</th>}
                  <th className="p-2">Counted</th>
                  {!blind && <th className="p-2 text-right">Difference</th>}
                  <th className="p-2">Check</th>
                </tr>
              </thead>
              <tbody>
                {(lines ?? []).map((l) => {
                  const isActive = l.id === activeLineId;
                  const outcome = l.tolerance_outcome as ToleranceOutcome | null;
                  const units = unitOptionsFor(l.product_id ? packsByProduct.get(l.product_id) : []);
                  const unit = optionByKey(units, unitByLine[l.id] ?? BASE_UNIT_KEY);

                  return (
                    <tr
                      key={l.id}
                      ref={isActive ? activeRowRef : null}
                      className={`border-t ${isActive ? "bg-primary/10" : ""}`}
                    >
                      <td className="p-2 font-mono">{l.location_code ?? "—"}</td>
                      <td className="p-2">
                        <span className={l.product_name ? undefined : "text-muted-foreground italic"}>
                          {countLineProductLabel(l)}
                        </span>
                        {countLineProductSubLabel(l) && (
                          <span className="text-muted-foreground text-xs"> · {countLineProductSubLabel(l)}</span>
                        )}

                        {(l.recount_round ?? 0) > 0 && (
                          <span className="ml-2 text-xs text-muted-foreground">recount #{l.recount_round}</span>
                        )}
                      </td>
                      <td className="p-2">{l.lot_number ?? "—"}</td>
                      {!blind && (
                        <td className="p-2 text-right font-mono">
                          {l.system_qty == null ? (
                            "—"
                          ) : (
                            <WarehouseQty fmt={qtyFmt} productId={l.product_id} baseQty={l.system_qty} />
                          )}

                        </td>
                      )}
                      <td className="p-2">
                        <div className="flex items-center gap-1">
                          <Input
                            type="number"
                            step="0.01"
                            className="w-24 h-8"
                            value={countedByLine[l.id] ?? (l.counted_qty ?? "")}
                            onChange={(e) => setCountedByLine((s) => ({ ...s, [l.id]: e.target.value }))}
                          />
                          {units.length > 1 && (
                            <Select
                              value={unitByLine[l.id] ?? BASE_UNIT_KEY}
                              onValueChange={(v) => setUnitByLine((s) => ({ ...s, [l.id]: v }))}
                            >
                              <SelectTrigger className="h-8 w-28"><SelectValue /></SelectTrigger>
                              <SelectContent>
                                {units.map((u) => (
                                  <SelectItem key={u.key} value={u.key}>{u.label}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          )}
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={record.isPending}
                            onClick={() => {
                              const val = Number(countedByLine[l.id] ?? l.counted_qty ?? 0);
                              if (Number.isNaN(val)) { toast.error("Invalid qty"); return; }
                              // Entered quantity + packaging level only —
                              // `record_count` derives the base figure.
                              record.mutate({
                                line_id: l.id,
                                counted_qty: val,
                                packaging_id: unit?.packagingId ?? null,
                              });
                            }}
                          >
                            Save
                          </Button>
                        </div>
                        {unit && !unit.isBase && Number(countedByLine[l.id] ?? 0) > 0 && (
                          <p className="mt-1 text-xs text-muted-foreground">
                            = {toBaseUnits(Number(countedByLine[l.id]), unit)} {qtyFmt.baseLabelFor(l.product_id)}
                          </p>
                        )}
                      </td>

                      {!blind && (
                        <td className={`p-2 text-right font-mono ${l.variance_qty && Number(l.variance_qty) !== 0 ? "text-destructive" : ""}`}>
                          {l.variance_qty == null ? (
                            "—"
                          ) : (
                            <WarehouseQty fmt={qtyFmt} productId={l.product_id} baseQty={l.variance_qty} signed />
                          )}
                        </td>
                      )}

                      <td className="p-2">
                        {outcome ? (
                          <div className="flex items-center gap-2">
                            <StatusBadge tone={TOLERANCE_COPY[outcome]?.tone ?? "info"}>
                              {TOLERANCE_COPY[outcome]?.label ?? outcome}
                            </StatusBadge>
                            {outcome === "recount_required" && !supersededIds.has(l.id) && (
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={recount.isPending}
                                onClick={() => recount.mutate({ line_id: l.id })}
                              >
                                <RotateCcw className="h-3.5 w-3.5 mr-1.5" /> Count again
                              </Button>
                            )}
                          </div>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>

                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Section>
        <ActivitySection aggregateId={sessionId} title="Session activity" description="Lifecycle events emitted for this count session." />
      </PageBody>
    </>
  );
}
