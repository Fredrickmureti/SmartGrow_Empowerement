/**
 * RecommendationDrawer — inspects a procurement recommendation and lets the
 * planner act on it: convert to PO, convert to warehouse transfer, edit
 * quantity, snooze, dismiss. Also renders the full audit trail from
 * `procurement_recommendation_events`.
 *
 * All writes go through security-definer RPCs (see
 * `useProcurementRecommendations`) which enforce business + branch access.
 */
import { useMemo, useState } from "react";
import { format } from "date-fns";
import { toast } from "sonner";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  ArrowRightLeft,
  ShoppingCart,
  Clock,
  Ban,
  Pencil,
  FileText,
} from "lucide-react";
import {
  useProcurementRecommendations,
  useRecommendationEvents,
  type ProcurementRecommendation,
} from "@/hooks/useProcurementRecommendations";
import { useWarehouses } from "@/hooks/useWarehouses";
import { normalizeError } from "@/services/resilience";

interface Props {
  rec: ProcurementRecommendation | null;
  open: boolean;
  onClose: () => void;
}

export function RecommendationDrawer({ rec, open, onClose }: Props) {
  const {
    snooze,
    setStatus,
    editQty,
    convertToPo,
    convertToTransfer,
  } = useProcurementRecommendations();
  const { warehouses } = useWarehouses();
  const { data: events = [] } = useRecommendationEvents(rec?.id ?? null);

  const [poNotes, setPoNotes] = useState("");
  const [poQty, setPoQty] = useState<string>("");
  const [xfFrom, setXfFrom] = useState<string>("");
  const [xfTo, setXfTo] = useState<string>("");
  const [xfQty, setXfQty] = useState<string>("");
  const [editValue, setEditValue] = useState<string>("");
  const [editReason, setEditReason] = useState("");
  const [snoozeDays, setSnoozeDays] = useState("7");

  const effectiveQty = useMemo(() => {
    if (!rec) return 0;
    return Number(rec.edited_qty ?? rec.suggested_qty) || 0;
  }, [rec]);

  if (!rec) return null;

  const busy =
    snooze.isPending ||
    setStatus.isPending ||
    editQty.isPending ||
    convertToPo.isPending ||
    convertToTransfer.isPending;

  const handleConvertPo = async () => {
    try {
      await convertToPo.mutateAsync({
        id: rec.id,
        qty: poQty ? Number(poQty) : null,
        notes: poNotes || null,
      });
      toast.success("Draft purchase order created");
      onClose();
    } catch (e) {
      toast.error(`Could not create PO: ${normalizeError(e).message}`);
    }
  };

  const handleConvertTransfer = async () => {
    if (!xfFrom || !xfTo) {
      toast.error("Pick source and destination warehouses");
      return;
    }
    try {
      await convertToTransfer.mutateAsync({
        id: rec.id,
        fromWarehouseId: xfFrom,
        toWarehouseId: xfTo,
        qty: xfQty ? Number(xfQty) : null,
      });
      toast.success("Draft stock transfer created");
      onClose();
    } catch (e) {
      toast.error(`Could not create transfer: ${normalizeError(e).message}`);
    }
  };

  const handleEditQty = async () => {
    const n = Number(editValue);
    if (!Number.isFinite(n) || n < 0) {
      toast.error("Enter a valid quantity");
      return;
    }
    if (!editReason.trim()) {
      toast.error("Please explain the override");
      return;
    }
    try {
      await editQty.mutateAsync({ id: rec.id, qty: n, reason: editReason });
      toast.success("Quantity updated");
      setEditValue("");
      setEditReason("");
    } catch (e) {
      toast.error(normalizeError(e).message);
    }
  };

  const handleSnooze = async () => {
    const days = Math.max(1, Number(snoozeDays) || 7);
    const until = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    try {
      await snooze.mutateAsync({ id: rec.id, until });
      toast.success(`Snoozed for ${days} day${days === 1 ? "" : "s"}`);
      onClose();
    } catch (e) {
      toast.error(normalizeError(e).message);
    }
  };

  const handleDismiss = async () => {
    try {
      await setStatus.mutateAsync({ id: rec.id, status: "dismissed" });
      toast.success("Dismissed");
      onClose();
    } catch (e) {
      toast.error(normalizeError(e).message);
    }
  };

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full sm:max-w-xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            {rec.product?.name ?? "Recommendation"}
            {rec.product?.sku && (
              <span className="text-sm font-normal text-muted-foreground">
                ({rec.product.sku})
              </span>
            )}
          </SheetTitle>
          <SheetDescription className="flex flex-wrap gap-2 items-center">
            <Badge variant={rec.urgency === "stockout" || rec.urgency === "critical" ? "destructive" : rec.urgency === "low" ? "default" : "secondary"}>
              {rec.urgency}
            </Badge>
            <Badge variant="outline">{rec.status}</Badge>
            {rec.branch?.name && <Badge variant="outline">{rec.branch.name}</Badge>}
            {rec.needed_by && (
              <span className="text-xs">Needed by {format(new Date(rec.needed_by), "MMM d, yyyy")}</span>
            )}
          </SheetDescription>
        </SheetHeader>

        <Tabs defaultValue="overview" className="mt-4">
          <TabsList className="w-full">
            <TabsTrigger value="overview" className="flex-1">Overview</TabsTrigger>
            <TabsTrigger value="actions" className="flex-1">Act</TabsTrigger>
            <TabsTrigger value="audit" className="flex-1">History</TabsTrigger>
          </TabsList>

          {/* -------- Overview -------- */}
          <TabsContent value="overview" className="space-y-4 pt-4">
            <div className="grid grid-cols-2 gap-2 text-sm">
              <Field label="On hand" value={rec.on_hand} />
              <Field label="Reserved" value={rec.reserved} />
              <Field label="Incoming" value={rec.incoming} />
              <Field label="Velocity / week" value={round(rec.velocity_per_week)} />
              <Field label="Safety stock" value={rec.safety_stock} />
              <Field label="Lead time (d)" value={rec.lead_time_days} />
              <Field label="Net requirement" value={round(rec.net_requirement)} />
              <Field label="Suggested qty" value={effectiveQty} strong />
              <Field label="Preferred vendor" value={rec.vendor?.name ?? "—"} />
              <Field label="Suggested source" value={rec.suggested_source} />
            </div>

            <Separator />
            <div className="text-xs text-muted-foreground">
              Formula: net = max(0, safety + velocity/7 × lead − available − incoming),
              then rounded up to pack size and floored at MOQ.
            </div>

            {rec.linked_po_id && (
              <div className="rounded-md border p-3 text-sm bg-muted/40">
                <FileText className="inline h-4 w-4 mr-1" />
                Linked purchase order {rec.linked_po_id.slice(0, 8)}…
              </div>
            )}
            {rec.linked_transfer_id && (
              <div className="rounded-md border p-3 text-sm bg-muted/40">
                <ArrowRightLeft className="inline h-4 w-4 mr-1" />
                Linked stock transfer {rec.linked_transfer_id.slice(0, 8)}…
              </div>
            )}

            <details className="rounded-md border p-3 text-xs">
              <summary className="cursor-pointer font-medium">Explanation payload</summary>
              <dl className="mt-2 grid grid-cols-2 gap-y-1 gap-x-4">
                {Object.entries(rec.explanation || {}).map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-muted-foreground">{k}</dt>
                    <dd className="text-right font-mono">
                      {typeof v === "number" ? Math.round(v * 100) / 100 : String(v ?? "—")}
                    </dd>
                  </div>
                ))}
              </dl>
            </details>
          </TabsContent>

          {/* -------- Actions -------- */}
          <TabsContent value="actions" className="space-y-6 pt-4">
            {/* Edit quantity */}
            <section className="space-y-2">
              <h3 className="text-sm font-semibold flex items-center gap-2">
                <Pencil className="h-4 w-4" /> Override quantity
              </h3>
              <div className="flex gap-2">
                <Input
                  type="number"
                  min={0}
                  placeholder={`${effectiveQty}`}
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                />
                <Input
                  placeholder="Reason (required)"
                  value={editReason}
                  onChange={(e) => setEditReason(e.target.value)}
                />
                <Button onClick={handleEditQty} disabled={busy}>Save</Button>
              </div>
            </section>

            <Separator />

            {/* Convert to PO */}
            <section className="space-y-2">
              <h3 className="text-sm font-semibold flex items-center gap-2">
                <ShoppingCart className="h-4 w-4" /> Create draft purchase order
              </h3>
              {!rec.preferred_vendor_id && (
                <p className="text-xs text-muted-foreground">
                  No preferred vendor on file — the recommendation must have one before a PO can be raised. Edit the reorder rule to set a vendor.
                </p>
              )}
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label className="text-xs">Quantity</Label>
                  <Input
                    type="number"
                    min={0}
                    placeholder={`${effectiveQty}`}
                    value={poQty}
                    onChange={(e) => setPoQty(e.target.value)}
                  />
                </div>
                <div>
                  <Label className="text-xs">Vendor</Label>
                  <Input value={rec.vendor?.name ?? "—"} disabled />
                </div>
              </div>
              <Textarea
                placeholder="Notes (optional)"
                value={poNotes}
                onChange={(e) => setPoNotes(e.target.value)}
                rows={2}
              />
              <Button
                onClick={handleConvertPo}
                disabled={busy || !rec.preferred_vendor_id || !!rec.linked_po_id}
                className="w-full"
              >
                Create PO
              </Button>
            </section>

            <Separator />

            {/* Convert to Transfer */}
            <section className="space-y-2">
              <h3 className="text-sm font-semibold flex items-center gap-2">
                <ArrowRightLeft className="h-4 w-4" /> Create draft warehouse transfer
              </h3>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label className="text-xs">From warehouse</Label>
                  <Select value={xfFrom} onValueChange={setXfFrom}>
                    <SelectTrigger><SelectValue placeholder="Source" /></SelectTrigger>
                    <SelectContent>
                      {warehouses.map((w) => (
                        <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs">To warehouse</Label>
                  <Select value={xfTo} onValueChange={setXfTo}>
                    <SelectTrigger><SelectValue placeholder="Destination" /></SelectTrigger>
                    <SelectContent>
                      {warehouses.map((w) => (
                        <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div>
                <Label className="text-xs">Quantity</Label>
                <Input
                  type="number"
                  min={0}
                  placeholder={`${effectiveQty}`}
                  value={xfQty}
                  onChange={(e) => setXfQty(e.target.value)}
                />
              </div>
              <Button
                onClick={handleConvertTransfer}
                disabled={busy || !!rec.linked_transfer_id}
                className="w-full"
                variant="secondary"
              >
                Create transfer
              </Button>
            </section>

            <Separator />

            {/* Snooze / dismiss */}
            <section className="space-y-2">
              <h3 className="text-sm font-semibold flex items-center gap-2">
                <Clock className="h-4 w-4" /> Defer
              </h3>
              <div className="flex items-center gap-2">
                <Label className="text-xs whitespace-nowrap">Snooze for (days)</Label>
                <Input
                  type="number"
                  min={1}
                  value={snoozeDays}
                  onChange={(e) => setSnoozeDays(e.target.value)}
                  className="w-24"
                />
                <Button variant="outline" onClick={handleSnooze} disabled={busy}>
                  Snooze
                </Button>
                <Button variant="ghost" onClick={handleDismiss} disabled={busy} className="ml-auto">
                  <Ban className="h-4 w-4 mr-1" /> Dismiss
                </Button>
              </div>
            </section>
          </TabsContent>

          {/* -------- Audit -------- */}
          <TabsContent value="audit" className="pt-4">
            {events.length === 0 ? (
              <p className="text-sm text-muted-foreground">No events yet.</p>
            ) : (
              <ol className="space-y-3 text-sm">
                {events.map((e) => (
                  <li key={e.id} className="border-l-2 border-muted pl-3">
                    <div className="flex items-center justify-between">
                      <Badge variant="outline">{e.event_type}</Badge>
                      <span className="text-xs text-muted-foreground">
                        {format(new Date(e.created_at), "MMM d, HH:mm")}
                      </span>
                    </div>
                    {(e.from_status || e.to_status) && (
                      <div className="text-xs mt-1">
                        {e.from_status ?? "—"} → {e.to_status ?? "—"}
                      </div>
                    )}
                    {e.note && <p className="text-xs mt-1 italic">"{e.note}"</p>}
                    {Object.keys(e.payload || {}).length > 0 && (
                      <pre className="text-[10px] mt-1 bg-muted/50 rounded p-1 overflow-x-auto">
                        {JSON.stringify(e.payload, null, 0)}
                      </pre>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </TabsContent>
        </Tabs>
      </SheetContent>
    </Sheet>
  );
}

function Field({ label, value, strong }: { label: string; value: string | number; strong?: boolean }) {
  return (
    <div className="flex justify-between border-b pb-1">
      <span className="text-muted-foreground">{label}</span>
      <span className={strong ? "font-semibold" : "font-mono"}>{value}</span>
    </div>
  );
}

function round(n: number) {
  return Math.round((Number(n) || 0) * 100) / 100;
}
