/**
 * ReturnLinesPanel — line-grain execution table for one return order
 * (Returns audit, Phase 4).
 *
 * Capture, inspection and disposition all write to `wms_return_lines` through
 * RPCs. The panel never mutates quantities locally: every action round-trips
 * with `row_version` so two clerks working the same dock cannot silently
 * overwrite each other.
 */
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { EmptyState, LoadingState, StatusBadge } from "@/design-system";
import { Boxes, ClipboardCheck, ListPlus, Split } from "lucide-react";
import { useProducts } from "@/hooks/useProducts";
import { useProductPackagingBatch } from "@/hooks/inventory/useProductPackagingBatch";
import { useWarehouseQtyFormatter, WarehouseQty } from "@/features/warehouse/quantity/warehouseQty";
import { useProductBaseUomLabels } from "@/features/warehouse/quantity/useProductBaseUomLabels";

import {
  unitOptionsFor, optionByKey, toBaseUnits, BASE_UNIT_KEY,
} from "@/features/warehouse/receiving/receivingUnits";
import { useWarehouseLocations } from "@/features/warehouse/locations/useWarehouseLocations";
import { ReturnPhotoStrip } from "./ReturnPhotoStrip";
import { ReturnRuleHint } from "./ReturnRuleHint";

import {
  useCaptureReturnLine,
  useDispositionReturnLine,
  useInspectReturnLine,
  useReturnLines,
} from "./useReturnLines";

import {
  RETURN_CONDITIONS,
  RETURN_DISPOSITIONS,
  type ReturnCondition,
  type ReturnDisposition,
  type ReturnLine,
  type ReturnOrder,
} from "./returnsModel";

const INSPECTION_TONE: Record<string, "info" | "warning" | "success" | "neutral" | "danger"> = {
  pending: "neutral",
  inspecting: "info",
  passed: "success",
  failed: "danger",
  conditional: "warning",
  waived: "neutral",
};

function label(value: string | null | undefined): string {
  return value ? value.replace(/_/g, " ") : "—";
}

export interface ReturnLinesPanelProps {
  order: ReturnOrder;
  /** Readonly once the header is terminal — history must stay immutable. */
  readOnly?: boolean;
}

export function ReturnLinesPanel({ order, readOnly = false }: ReturnLinesPanelProps) {
  const { data: lines, isLoading } = useReturnLines(order.id);
  const { products } = useProducts();
  const { ordered: locations } = useWarehouseLocations(order.warehouse_id ?? null);

  const capture = useCaptureReturnLine();
  const inspect = useInspectReturnLine();
  const disposition = useDispositionReturnLine();

  const [captureOpen, setCaptureOpen] = useState(false);
  const [captureForm, setCaptureForm] = useState({
    productId: "",
    receivedQty: "1",
    expectedQty: "",
    lotNumber: "",
    serialNumber: "",
    conditionCode: "unopened" as ReturnCondition,
    notes: "",
  });

  const [inspectLine, setInspectLine] = useState<ReturnLine | null>(null);
  const [inspectForm, setInspectForm] = useState({
    outcome: "passed" as "passed" | "failed" | "conditional" | "waived",
    conditionCode: "" as ReturnCondition | "",
    notes: "",
  });

  const [dispLine, setDispLine] = useState<ReturnLine | null>(null);
  const [dispForm, setDispForm] = useState({
    mode: "rule" as "rule" | "manual",
    disposition: "restock" as ReturnDisposition,
    restockQty: "",
    quarantineQty: "0",
    scrapQty: "0",
    destinationLocationId: "",
    notes: "",
  });

  const putawayTargets = useMemo(
    () => locations.filter((l) => l.is_active !== false),
    [locations],
  );

  // Phase 2 — the clerk captures in the unit the carton actually arrives in.
  // Only the packaging level travels to the server; `wms_to_base_qty` does the
  // multiplication against the canonical Product foundation.
  const [unitKey, setUnitKey] = useState<string>(BASE_UNIT_KEY);
  const { packsByProduct } = useProductPackagingBatch(
    captureForm.productId ? [captureForm.productId] : [],
  );
  const captureUnits = useMemo(
    () => unitOptionsFor(captureForm.productId ? packsByProduct.get(captureForm.productId) : []),
    [packsByProduct, captureForm.productId],
  );
  const captureUnit = optionByKey(captureUnits, unitKey);

  // Phase 2.4 — unit truth on every rendered return quantity.
  const lineProductIds = useMemo(
    () => (lines ?? []).map((l) => l.product_id),
    [lines],
  );
  const qtyBaseLabels = useProductBaseUomLabels(lineProductIds);
  const qtyFmt = useWarehouseQtyFormatter(lineProductIds, qtyBaseLabels);


  const submitCapture = () => {
    if (!captureForm.productId) {
      toast.error("Pick a product");
      return;
    }
    const qty = Number(captureForm.receivedQty);
    if (!Number.isFinite(qty) || qty <= 0) {
      toast.error("Received quantity must be greater than zero");
      return;
    }
    capture.mutate(
      {
        returnId: order.id,
        productId: captureForm.productId,
        // Entered quantity + packaging level — never a client-converted figure.
        receivedQty: qty,
        packagingId: captureUnit?.packagingId ?? null,
        uom: captureUnit?.packagingId ? null : (captureUnit?.uom ?? null),
        expectedQty: captureForm.expectedQty ? Number(captureForm.expectedQty) : null,
        lotNumber: captureForm.lotNumber || null,
        serialNumber: captureForm.serialNumber || null,
        conditionCode: captureForm.conditionCode,
        notes: captureForm.notes || null,
        clientScanId: crypto.randomUUID(),
      },
      {
        onSuccess: (res) => {
          toast.success(res.replayed ? "Scan already recorded" : "Line captured");
          setCaptureOpen(false);
          setCaptureForm((f) => ({ ...f, receivedQty: "1", lotNumber: "", serialNumber: "", notes: "" }));
          setUnitKey(BASE_UNIT_KEY);
        },
        onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Capture rejected"),
      },
    );
  };


  const submitInspection = () => {
    if (!inspectLine) return;
    inspect.mutate(
      {
        lineId: inspectLine.id,
        rowVersion: inspectLine.row_version,
        inspectionState: inspectForm.outcome,
        conditionCode: inspectForm.conditionCode || null,
        notes: inspectForm.notes || null,
      },
      {
        onSuccess: () => {
          toast.success("Inspection recorded");
          setInspectLine(null);
        },
        onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Inspection rejected"),
      },
    );
  };

  /**
   * Returns audit Phase 5 — evidence gate. `wms_disposition_return_line`
   * refuses a damaged/defective line with no photo; mirror that client-side
   * so the operator is told *before* the round-trip instead of eating a
   * raw SQL exception.
   */
  const evidenceRequired =
    !!dispLine &&
    (dispLine.condition_code === "damaged" || dispLine.condition_code === "defective");
  const evidenceMissing = evidenceRequired && !(dispLine?.photo_count ?? 0);

  const submitDisposition = () => {
    if (!dispLine) return;
    if (evidenceMissing) {
      toast.error("Photo evidence is required before dispositioning a damaged or defective line");
      return;
    }
    const manual = dispForm.mode === "manual";
    disposition.mutate(
      {
        lineId: dispLine.id,
        rowVersion: dispLine.row_version,
        disposition: manual ? dispForm.disposition : null,
        restockQty: manual && dispForm.restockQty ? Number(dispForm.restockQty) : null,
        quarantineQty: manual ? Number(dispForm.quarantineQty || 0) : null,
        scrapQty: manual ? Number(dispForm.scrapQty || 0) : null,
        destinationLocationId: dispForm.destinationLocationId || null,
        notes: dispForm.notes || null,
      },
      {
        onSuccess: (res) => {
          toast.success(`Dispositioned: ${label(res.disposition)}`);
          setDispLine(null);
        },
        onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Disposition rejected"),
      },
    );
  };

  if (isLoading) return <LoadingState />;

  const rows = lines ?? [];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium">
          Lines <span className="text-muted-foreground tabular-nums">({rows.length})</span>
        </div>
        {!readOnly && (
          <Button size="sm" onClick={() => setCaptureOpen(true)}>
            <ListPlus className="mr-1.5 h-3.5 w-3.5" /> Capture line
          </Button>
        )}
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon={Boxes}
          title="No lines captured"
          description="Capture each returned item so condition, inspection and disposition are recorded per unit."
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Product</TableHead>
              <TableHead className="text-right">Qty</TableHead>
              <TableHead>Condition</TableHead>
              <TableHead>Inspection</TableHead>
              <TableHead>Disposition</TableHead>
              <TableHead className="text-right">Split</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((line) => (
              <TableRow key={line.id} className={line.blocked_reason ? "bg-destructive/5" : undefined}>
                <TableCell>
                  <div className="text-sm">{line.products?.name ?? "—"}</div>
                  <div className="font-mono text-xs text-muted-foreground">
                    {line.products?.sku ?? line.product_id?.slice(0, 8) ?? "—"}
                    {line.lot_number ? ` · lot ${line.lot_number}` : ""}
                    {line.serial_number ? ` · sn ${line.serial_number}` : ""}
                  </div>
                  {line.blocked_reason && (
                    <div className="text-xs text-destructive">{line.blocked_reason}</div>
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  <WarehouseQty fmt={qtyFmt} productId={line.product_id} baseQty={line.received_qty} />
                  {line.expected_qty != null && (
                    <span className="text-xs text-muted-foreground">
                      {" / "}
                      <WarehouseQty fmt={qtyFmt} productId={line.product_id} baseQty={line.expected_qty} />
                    </span>
                  )}
                  {line.packaging?.name && line.entered_qty != null && (
                    <span className="block text-xs text-muted-foreground">
                      entered {Number(line.entered_qty)} × {line.packaging.name}
                    </span>
                  )}

                </TableCell>
                <TableCell className="text-sm">{label(line.condition_code)}</TableCell>
                <TableCell>
                  <StatusBadge tone={INSPECTION_TONE[line.inspection_state] ?? "neutral"}>
                    {label(line.inspection_state)}
                  </StatusBadge>
                </TableCell>
                <TableCell className="text-sm">{label(line.disposition)}</TableCell>
                <TableCell className="text-right text-xs tabular-nums text-muted-foreground">
                  {Number(line.restock_qty ?? 0)}/{Number(line.quarantine_qty ?? 0)}/
                  {Number(line.scrap_qty ?? 0)} {qtyFmt.baseLabelFor(line.product_id)}

                </TableCell>
                <TableCell className="space-x-1 text-right">
                  {!readOnly && !line.posted_at && (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setInspectForm({
                            outcome: "passed",
                            conditionCode: line.condition_code ?? "",
                            notes: "",
                          });
                          setInspectLine(line);
                        }}
                      >
                        <ClipboardCheck className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setDispForm({
                            mode: "rule",
                            disposition: line.disposition ?? "restock",
                            restockQty: String(line.received_qty ?? ""),
                            quarantineQty: "0",
                            scrapQty: "0",
                            destinationLocationId: line.destination_location_id ?? "",
                            notes: "",
                          });
                          setDispLine(line);
                        }}
                      >
                        <Split className="h-3.5 w-3.5" />
                      </Button>
                    </>
                  )}
                  {line.posted_at && (
                    <span className="text-xs text-muted-foreground">posted</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {/* ---- Capture ---------------------------------------------------- */}
      <Dialog open={captureOpen} onOpenChange={setCaptureOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Capture return line</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Product</Label>
              <Select
                value={captureForm.productId}
                onValueChange={(v) => setCaptureForm({ ...captureForm, productId: v })}
              >
                <SelectTrigger><SelectValue placeholder="Choose product" /></SelectTrigger>
                <SelectContent>
                  {products.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}{p.sku ? ` · ${p.sku}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="min-w-0 grid grid-cols-3 gap-3">
              <div>
                <Label>Received qty</Label>
                <Input
                  type="number"
                  min="0"
                  value={captureForm.receivedQty}
                  onChange={(e) => setCaptureForm({ ...captureForm, receivedQty: e.target.value })}
                />
              </div>
              <div>
                <Label>Unit</Label>
                <Select
                  value={unitKey}
                  onValueChange={setUnitKey}
                  disabled={captureUnits.length < 2}
                >
                  <SelectTrigger><SelectValue placeholder="ea" /></SelectTrigger>
                  <SelectContent>
                    {captureUnits.map((u) => (
                      <SelectItem key={u.key} value={u.key}>{u.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Expected qty</Label>
                <Input
                  type="number"
                  min="0"
                  value={captureForm.expectedQty}
                  onChange={(e) => setCaptureForm({ ...captureForm, expectedQty: e.target.value })}
                />
              </div>
            </div>
            {captureUnit && !captureUnit.isBase && Number(captureForm.receivedQty) > 0 && (
              <p className="text-xs text-muted-foreground">
                Books {toBaseUnits(Number(captureForm.receivedQty), captureUnit)} base unit
                {toBaseUnits(Number(captureForm.receivedQty), captureUnit) === 1 ? "" : "s"} —
                {" "}{captureForm.receivedQty} × {captureUnit.label} (converted server-side).
              </p>
            )}

            <div className="min-w-0 grid grid-cols-2 gap-3">
              <div>
                <Label>Lot</Label>
                <Input
                  value={captureForm.lotNumber}
                  onChange={(e) => setCaptureForm({ ...captureForm, lotNumber: e.target.value })}
                />
              </div>
              <div>
                <Label>Serial</Label>
                <Input
                  value={captureForm.serialNumber}
                  onChange={(e) => setCaptureForm({ ...captureForm, serialNumber: e.target.value })}
                />
              </div>
            </div>
            <div>
              <Label>Condition</Label>
              <Select
                value={captureForm.conditionCode}
                onValueChange={(v) =>
                  setCaptureForm({ ...captureForm, conditionCode: v as ReturnCondition })
                }
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {RETURN_CONDITIONS.map((c) => (
                    <SelectItem key={c} value={c}>{label(c)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Notes</Label>
              <Textarea
                value={captureForm.notes}
                onChange={(e) => setCaptureForm({ ...captureForm, notes: e.target.value })}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCaptureOpen(false)}>Cancel</Button>
            <Button onClick={submitCapture} disabled={capture.isPending}>Capture</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---- Inspection ------------------------------------------------- */}
      <Dialog open={!!inspectLine} onOpenChange={(o) => !o && setInspectLine(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Record inspection</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Outcome</Label>
              <Select
                value={inspectForm.outcome}
                onValueChange={(v) =>
                  setInspectForm({ ...inspectForm, outcome: v as typeof inspectForm.outcome })
                }
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="passed">Passed</SelectItem>
                  <SelectItem value="failed">Failed</SelectItem>
                  <SelectItem value="conditional">Conditional</SelectItem>
                  <SelectItem value="waived">Waived</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Condition (revised)</Label>
              <Select
                value={inspectForm.conditionCode || undefined}
                onValueChange={(v) =>
                  setInspectForm({ ...inspectForm, conditionCode: v as ReturnCondition })
                }
              >
                <SelectTrigger><SelectValue placeholder="Keep captured condition" /></SelectTrigger>
                <SelectContent>
                  {RETURN_CONDITIONS.map((c) => (
                    <SelectItem key={c} value={c}>{label(c)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Findings</Label>
              <Textarea
                value={inspectForm.notes}
                onChange={(e) => setInspectForm({ ...inspectForm, notes: e.target.value })}
              />
            </div>
            {inspectLine && (
              <ReturnPhotoStrip order={order} line={inspectLine} kind="inspection" readOnly={readOnly} />
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setInspectLine(null)}>Cancel</Button>
            <Button onClick={submitInspection} disabled={inspect.isPending}>Record</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---- Disposition ------------------------------------------------ */}
      <Dialog open={!!dispLine} onOpenChange={(o) => !o && setDispLine(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Disposition line</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Mode</Label>
              <Select
                value={dispForm.mode}
                onValueChange={(v) => setDispForm({ ...dispForm, mode: v as "rule" | "manual" })}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="rule">Apply disposition rule</SelectItem>
                  <SelectItem value="manual">Manual override</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {dispForm.mode === "rule" && dispLine && (
              <ReturnRuleHint order={order} line={dispLine} />
            )}

            {dispForm.mode === "manual" && (
              <>
                <div>
                  <Label>Disposition</Label>
                  <Select
                    value={dispForm.disposition}
                    onValueChange={(v) =>
                      setDispForm({ ...dispForm, disposition: v as ReturnDisposition })
                    }
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {RETURN_DISPOSITIONS.map((d) => (
                        <SelectItem key={d} value={d}>{label(d)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="min-w-0 grid grid-cols-3 gap-3">
                  <div>
                    <Label>Restock</Label>
                    <Input
                      type="number"
                      min="0"
                      value={dispForm.restockQty}
                      onChange={(e) => setDispForm({ ...dispForm, restockQty: e.target.value })}
                    />
                  </div>
                  <div>
                    <Label>Quarantine</Label>
                    <Input
                      type="number"
                      min="0"
                      value={dispForm.quarantineQty}
                      onChange={(e) => setDispForm({ ...dispForm, quarantineQty: e.target.value })}
                    />
                  </div>
                  <div>
                    <Label>Scrap</Label>
                    <Input
                      type="number"
                      min="0"
                      value={dispForm.scrapQty}
                      onChange={(e) => setDispForm({ ...dispForm, scrapQty: e.target.value })}
                    />
                  </div>
                </div>
              </>
            )}
            <div>
              <Label>Destination location</Label>
              <Select
                value={dispForm.destinationLocationId || undefined}
                onValueChange={(v) => setDispForm({ ...dispForm, destinationLocationId: v })}
              >
                <SelectTrigger><SelectValue placeholder="Rule default" /></SelectTrigger>
                <SelectContent>
                  {putawayTargets.map((l) => (
                    <SelectItem key={l.id} value={l.id}>{l.code}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Notes</Label>
              <Textarea
                value={dispForm.notes}
                onChange={(e) => setDispForm({ ...dispForm, notes: e.target.value })}
              />
            </div>
            {evidenceRequired && dispLine && (
              <div className="space-y-2">
                <ReturnPhotoStrip order={order} line={dispLine} kind="damage" readOnly={readOnly} />
                {evidenceMissing && (
                  <p className="text-xs text-destructive">
                    A {label(dispLine.condition_code)} line needs at least one photo before it can be
                    dispositioned.
                  </p>
                )}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDispLine(null)}>Cancel</Button>
            <Button
              onClick={submitDisposition}
              disabled={disposition.isPending || evidenceMissing}
            >
              Apply
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
