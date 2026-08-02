/**
 * ReceivingSessionWorkspace — line-grain capture surface for one receiving
 * session (Receiving audit, Phases 2–5).
 *
 * The session list no longer flips a whole session to `captured` on a single
 * scan. Every scan or manual capture writes a `wms_receiving_lines` row via
 * `wms_capture_receiving_line`, carrying quantity, lot, serial, expiry, damage
 * and quality-hold. Variance against the bound PO/ASN is therefore
 * computable, and posting goes through the single sanctioned path
 * (`wms_post_receiving_session`) which creates the goods receipt, stages the
 * stock for put-away, and only then advances the session.
 */
import { Fragment, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Separator } from "@/components/ui/separator";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { StatusBadge, LoadingState, EmptyState } from "@/design-system";
import { AlertTriangle, Boxes, ListPlus, PackageCheck, ScanLine, ShieldAlert, Check, X, History, Truck } from "lucide-react";

import { useWmsScanIntent, type WmsScanPayload } from "@/features/warehouse/scanning/wmsScanIntent";
import { ScanStatusChip } from "@/features/warehouse/scanning/ScanStatusChip";
import { useWmsIdentityGate, describeLevel } from "@/features/warehouse/scanning/useWmsIdentityGate";
import {
  useReceivingLines,
  useMaterializeExpectedLines,
  useCaptureReceivingLine,
  useFlagVariances,
  usePostReceivingSession,
  type ReceivingLine,
} from "./useReceivingLines";
import { useActiveLpn } from "./useReceivingLpn";
import { useReceivingTrailerVisits, dwellMinutes } from "./useReceivingTrailerVisits";
import { ReceivingExceptionStrip } from "./ReceivingExceptionStrip";
import { OutboxTimeline } from "@/features/warehouse/events/OutboxTimeline";
import { useProductTrackingFlags } from "@/hooks/useProductTrackingFlags";

export interface ReceivingSessionSummary {
  id: string;
  code: string;
  state: string;
  row_version: number;
  source_doc_type: string | null;
  source_doc_id: string | null;
  /** Link to the yard's trailer visit (carrier, seal, dwell) when scheduled. */
  appointment_id?: string | null;
}


interface Props {
  session: ReceivingSessionSummary | null;
  businessId: string | undefined;
  onClose: () => void;
}

function variance(line: ReceivingLine): number {
  return Number(line.received_qty ?? 0) - Number(line.expected_qty ?? 0);
}

/**
 * Phase 5c — dwell is an operational clock, not a static field. A trailer
 * still on the dock re-renders every 30s so the number on screen is the number
 * the yard is being billed for.
 */
function useDwellTicker(active: boolean) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, [active]);
}

function CaptureRow({
  line,
  onCapture,
  busy,
  serialTracked,
}: {
  line: ReceivingLine;
  onCapture: (v: {
    qty: number; lot: string | null; serial: string | null; expiry: string | null; damaged: number; hold: boolean;
  }) => void;
  busy: boolean;
  /** ADR-0067: serial-tracked products need one serial per unit at receipt. */
  serialTracked: boolean;
}) {
  const outstanding = Math.max(Number(line.expected_qty ?? 0) - Number(line.received_qty ?? 0), 0);
  const [qty, setQty] = useState<string>(serialTracked ? "1" : outstanding ? String(outstanding) : "");
  const [lot, setLot] = useState(line.lot_number ?? "");
  const [serial, setSerial] = useState("");
  const [expiry, setExpiry] = useState(line.expiry_date ?? "");
  const [damaged, setDamaged] = useState("");
  const [hold, setHold] = useState(false);
  // One unit per capture keeps the serial ↔ unit relationship 1:1, which the
  // `enforce_serial_on_movement` trigger requires when the receipt posts.
  const serialInvalid = serialTracked && (!serial.trim() || Number(qty) !== 1);

  return (
    <div className="flex flex-wrap items-end gap-2 rounded-md border bg-muted/40 p-3">
      <div className="w-24">
        <Label className="text-xs">Qty</Label>
        <Input
          value={qty}
          onChange={(e) => setQty(e.target.value)}
          inputMode="decimal"
          disabled={serialTracked}
        />
      </div>
      {serialTracked && (
        <div className="w-40">
          <Label className="text-xs">Serial</Label>
          <Input
            value={serial}
            onChange={(e) => setSerial(e.target.value)}
            placeholder="One unit per capture"
          />
        </div>
      )}
      <div className="w-32">
        <Label className="text-xs">Lot</Label>
        <Input value={lot} onChange={(e) => setLot(e.target.value)} />
      </div>
      <div className="w-40">
        <Label className="text-xs">Expiry</Label>
        <Input type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} />
      </div>
      <div className="w-24">
        <Label className="text-xs">Damaged</Label>
        <Input value={damaged} onChange={(e) => setDamaged(e.target.value)} inputMode="decimal" />
      </div>
      <label className="flex items-center gap-2 pb-2 text-xs">
        <Checkbox checked={hold} onCheckedChange={(v) => setHold(!!v)} /> Quality hold
      </label>
      <Button
        size="sm"
        disabled={busy || !Number(qty) || serialInvalid}
        onClick={() => {
          onCapture({
            qty: serialTracked ? 1 : Number(qty),
            lot: lot.trim() || null,
            serial: serialTracked ? serial.trim() : null,
            expiry: expiry || null,
            damaged: Number(damaged) || 0,
            hold,
          });
          if (serialTracked) setSerial("");
        }}
      >
        <PackageCheck className="mr-1 h-3.5 w-3.5" /> Capture
      </Button>
      {serialInvalid && (
        <p className="w-full text-xs text-destructive">
          Serial-tracked item — capture one unit at a time with its serial number.
        </p>
      )}
    </div>
  );
}

export default function ReceivingSessionWorkspace({ session, businessId, onClose }: Props) {
  const open = !!session;
  const { data: lines, isLoading } = useReceivingLines(session?.id);
  const materialize = useMaterializeExpectedLines();
  const capture = useCaptureReceivingLine();
  const flag = useFlagVariances();
  const post = usePostReceivingSession();
  const gate = useWmsIdentityGate(businessId);
  const [expandedLine, setExpandedLine] = useState<string | null>(null);

  // Tracking flags for every product on the session — batched once so each
  // capture row knows whether it must demand a serial.
  const tracking = useProductTrackingFlags((lines ?? []).map((l) => l.product_id));

  // Phase 4c — the pallet under the operator's hands. Bound by a
  // `receiving.lpn` scan or typed, then stamped onto every capture.
  const { activeLpn, bind: bindLpn, clear: clearLpn, resolving: lpnBusy } = useActiveLpn(businessId);
  const [lpnInput, setLpnInput] = useState("");

  const applyLpn = async (code: string) => {
    const trimmed = code.trim();
    if (!trimmed) return;
    try {
      const lpn = await bindLpn(trimmed);
      if (lpn) {
        setLpnInput("");
        toast.success(`Working on plate ${lpn.code}`);
      } else {
        toast.error(`No license plate ${trimmed} in this business`);
      }
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Plate lookup failed");
    }
  };

  const totals = useMemo(() => {
    const rows = lines ?? [];
    return {
      expected: rows.reduce((s, l) => s + Number(l.expected_qty ?? 0), 0),
      received: rows.reduce((s, l) => s + Number(l.received_qty ?? 0), 0),
      short: rows.filter((l) => l.line_state !== "expected" && variance(l) < 0).length,
      over: rows.filter((l) => variance(l) > 0).length,
      unexpected: rows.filter((l) => l.line_state === "unexpected").length,
      pending: rows.filter((l) => l.line_state === "expected").length,
      holds: rows.filter((l) => l.qc_hold).length,
    };
  }, [lines]);

  // Trailer context for the session on screen — resolved through the dock
  // appointment from the yard's visit record. Read-only.
  const trailerVisits = useReceivingTrailerVisits(
    businessId,
    session?.appointment_id ? [session.appointment_id] : [],
  );
  const visit = session?.appointment_id ? (trailerVisits?.get(session.appointment_id) ?? null) : null;



  // A pallet scan binds the handling unit; it never captures a line.
  useWmsScanIntent({
    intent: "receiving.lpn",
    priority: 30,
    enabled: open,
    label: "receiving-workspace.lpn",
    onScan: async (p: WmsScanPayload) => { await applyLpn(p.raw); },
  });

  // Scan capture for the session currently on screen. Priority 30 so the sheet
  // outranks the list-level intent while open.
  useWmsScanIntent({
    intent: "receiving.item",
    priority: 30,
    enabled: open,
    label: "receiving-workspace.item",
    onScan: async (p: WmsScanPayload) => {
      if (!session) return;
      const gated = await gate.gate({ raw: p.raw, resolveCode: p.resolveCode, workflow: "receive" });
      if (!gated) return;
      const { identity, baseUnits, lot, serial, expiry } = gated;
      if (tracking.get(identity.productId).is_serial_tracked && !serial) {
        toast.error(`${identity.productName} is serial-tracked — scan the unit serial (GS1 AI 21)`);
        return;
      }
      await capture.mutateAsync({
        sessionId: session.id,
        productId: identity.productId,
        receivedQty: baseUnits,
        lotNumber: lot,
        serialNumber: serial,
        expiryDate: expiry ? expiry.toISOString().slice(0, 10) : null,
        lpnId: activeLpn?.id ?? null,
        clientScanId: `${session.id}:${p.raw}:${Date.now()}`,
      });
      toast.success(`${identity.productName} +${baseUnits}`, {
        description: `${describeLevel(identity)}${lot ? ` · lot ${lot}` : ""}`,
      });
    },
  });

  const runCapture = (line: ReceivingLine, v: { qty: number; lot: string | null; serial: string | null; expiry: string | null; damaged: number; hold: boolean }) => {
    if (!session || !line.product_id) return;
    capture.mutate(
      {
        sessionId: session.id,
        productId: line.product_id,
        receivedQty: v.qty,
        expectedQty: line.expected_qty,
        lotNumber: v.lot,
        serialNumber: v.serial,
        expiryDate: v.expiry,
        damagedQty: v.damaged,
        qcHold: v.hold,
        lpnId: activeLpn?.id ?? null,
      },
      {
        onSuccess: () => {
          setExpandedLine(null);
          toast.success("Line captured");
        },
        onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Capture failed"),
      },
    );
  };

  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent side="right" className="w-full sm:max-w-3xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2 font-mono">
            {session?.code}
            {session && <StatusBadge tone="info">{session.state}</StatusBadge>}
          </SheetTitle>
          <SheetDescription className="flex items-center gap-1">
            <ScanLine className="h-3.5 w-3.5" />
            Scans land on lines while this panel is open — quantity, lot, expiry and damage are recorded, not narrated.
          </SheetDescription>
        </SheetHeader>

        {visit ? (
          <div className="mt-3 rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="flex items-center gap-1.5">
              <Truck className="h-3.5 w-3.5" />
              {[visit.carrier_name, visit.trailer_ref].filter(Boolean).join(" · ") || "trailer on dock"}
            </span>
            {visit.driver_name ? <span>driver {visit.driver_name}</span> : null}
            {visit.seal_in || visit.seal_out ? (
              <span>seal in {visit.seal_in ?? "—"}{visit.seal_out ? ` · out ${visit.seal_out}` : ""}</span>
            ) : null}
            {(() => {
              const d = dwellMinutes(visit);
              return d == null ? null : <span>{visit.departed_at ? "dwell" : "on site"} {d} min</span>;
            })()}
          </div>
        ) : null}



        <ScanStatusChip
          expectedLabel="receiving-workspace.item"
          hint="Scan an item to capture against its expected line"
          className="mt-3"
        />


        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Boxes className="h-4 w-4 text-muted-foreground" />
          {activeLpn ? (
            <>
              <StatusBadge tone="success">plate {activeLpn.code}</StatusBadge>
              <Button size="sm" variant="ghost" onClick={clearLpn}>
                <X className="mr-1 h-3.5 w-3.5" /> Release
              </Button>
            </>
          ) : (
            <>
              <Input
                className="h-8 w-48"
                placeholder="Scan or type pallet / LPN"
                value={lpnInput}
                disabled={lpnBusy}
                onChange={(e) => setLpnInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void applyLpn(lpnInput); }}
              />
              <Button size="sm" variant="outline" disabled={lpnBusy || !lpnInput.trim()} onClick={() => void applyLpn(lpnInput)}>
                Bind plate
              </Button>
              <span className="text-xs text-muted-foreground">optional — captures without a plate stay unpalletised</span>
            </>
          )}
        </div>

        <div className="mt-4 flex flex-wrap gap-2 text-xs">
          <StatusBadge tone="neutral">expected {totals.expected}</StatusBadge>
          <StatusBadge tone="info">received {totals.received}</StatusBadge>
          <StatusBadge tone={totals.short ? "danger" : "neutral"}>short {totals.short}</StatusBadge>
          <StatusBadge tone={totals.over ? "warning" : "neutral"}>over {totals.over}</StatusBadge>
          <StatusBadge tone={totals.unexpected ? "warning" : "neutral"}>unexpected {totals.unexpected}</StatusBadge>
          <StatusBadge tone={totals.holds ? "danger" : "neutral"}>holds {totals.holds}</StatusBadge>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={!session?.source_doc_id || materialize.isPending}
            onClick={() =>
              session &&
              materialize.mutate(session.id, {
                onSuccess: (r) =>
                  r?.created
                    ? toast.success(`${r.created} expected line(s) loaded`)
                    : toast.info(r?.reason ?? "Nothing new to load"),
                onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Load failed"),
              })
            }
          >
            <ListPlus className="mr-1 h-3.5 w-3.5" /> Load expected lines
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!session || flag.isPending}
            onClick={() =>
              session &&
              flag.mutate(session.id, {
                onSuccess: (r) => toast.success(`${r?.raised ?? 0} exception(s) raised`),
                onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Flagging failed"),
              })
            }
          >
            <ShieldAlert className="mr-1 h-3.5 w-3.5" /> Raise variance exceptions
          </Button>
          <Button
            size="sm"
            disabled={!session || post.isPending || !["captured", "discrepant"].includes(session.state)}
            onClick={() =>
              session &&
              post.mutate(
                { sessionId: session.id, rowVersion: session.row_version },
                {
                  onSuccess: (r) => {
                    toast.success(`Posted as ${r?.receipt_number ?? "goods receipt"}`);
                    onClose();
                  },
                  onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Post failed"),
                },
              )
            }
          >
            <Check className="mr-1 h-3.5 w-3.5" /> Post to inventory
          </Button>
        </div>

        <Separator className="my-4" />

        {isLoading ? (
          <LoadingState />
        ) : (lines ?? []).length === 0 ? (
          <EmptyState
            icon={AlertTriangle}
            title="No lines yet"
            description={
              session?.source_doc_id
                ? "Load the expected lines from the bound source document, then scan or capture against them."
                : "This session has no source document bound — scanned items will be recorded as unexpected receipts."
            }
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Item</TableHead>
                <TableHead className="text-right">Expected</TableHead>
                <TableHead className="text-right">Received</TableHead>
                <TableHead className="text-right">Variance</TableHead>
                <TableHead>Lot / expiry</TableHead>
                <TableHead>State</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(lines ?? []).map((l) => {
                const v = variance(l);
                return (
                  <Fragment key={l.id}>
                    <TableRow>
                      <TableCell className="text-sm">
                        {l.products?.name ?? "—"}
                        {l.products?.sku && <span className="ml-1 text-xs text-muted-foreground font-mono">{l.products.sku}</span>}
                      </TableCell>
                      <TableCell className="text-right">{Number(l.expected_qty ?? 0)}</TableCell>
                      <TableCell className="text-right">{Number(l.received_qty ?? 0)}</TableCell>
                      <TableCell className={`text-right ${v === 0 ? "" : v < 0 ? "text-destructive" : "text-warning"}`}>
                        {v > 0 ? `+${v}` : v}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {[l.lot_number, l.expiry_date].filter(Boolean).join(" · ") || "—"}
                      </TableCell>
                      <TableCell>
                        <StatusBadge
                          tone={
                            l.qc_hold ? "danger"
                            : l.line_state === "unexpected" ? "warning"
                            : l.line_state === "captured" ? "success"
                            : "neutral"
                          }
                        >
                          {l.qc_hold ? "hold" : l.line_state}
                        </StatusBadge>
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setExpandedLine(expandedLine === l.id ? null : l.id)}
                        >
                          Receive
                        </Button>
                      </TableCell>
                    </TableRow>
                    {expandedLine === l.id && (
                      <TableRow>
                        <TableCell colSpan={7}>
                          <CaptureRow
                            line={l}
                            busy={capture.isPending}
                            serialTracked={tracking.get(l.product_id).is_serial_tracked}
                            onCapture={(v2) => runCapture(l, v2)}
                          />
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        )}
        {session && (
          <>
            <Separator className="my-4" />
            <div className="space-y-2">
              <div className="flex items-center gap-1.5 text-sm font-medium">
                <History className="h-4 w-4" /> Activity
              </div>
              <p className="text-xs text-muted-foreground">
                Lifecycle events emitted for this session — arrival, capture, variance, posting.
              </p>
              <OutboxTimeline aggregateId={session.id} limit={50} />
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
