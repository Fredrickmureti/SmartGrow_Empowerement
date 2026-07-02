import { useState, useMemo } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Collapsible, CollapsibleContent, CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Truck, ChevronDown, CheckCircle, Loader2, Clock, ClipboardSignature,
  Package, PackageCheck,
} from "lucide-react";
import {
  useCarriers,
  useDeliveryNoteEvents,
  useDeliveryProofs,
  useDispatchDelivery,
  useMarkDeliveryReady,
  useCompleteDelivery,
  useUpdateDeliveryLogistics,
} from "@/hooks/useDeliveryLifecycle";
import { format, parseISO } from "date-fns";
import { PartialDeliveryDialog, type PartialItem } from "./PartialDeliveryDialog";
import {
  type DeliveryNoteStatus,
  FINAL_DELIVERY_STATUSES,
} from "@/types/deliveryNote";

const SHIPPING_METHODS = [
  { value: "pickup", label: "Customer Pickup" },
  { value: "own_vehicle", label: "Own Vehicle" },
  { value: "courier", label: "Courier" },
  { value: "third_party_logistics", label: "Third-party Logistics (3PL)" },
  { value: "freight", label: "Freight" },
];

const EVENT_LABEL: Record<string, string> = {
  ready_to_dispatch: "Marked ready to dispatch",
  dispatched: "Dispatched",
  delivered: "Delivered",
  partially_delivered: "Partially delivered",
  logistics_updated: "Logistics updated",
  backorder_created: "Backorder created",
};

export interface DeliveryLogisticsDN {
  id: string;
  status: DeliveryNoteStatus | string;
  shipping_method?: string | null;
  carrier_id?: string | null;
  tracking_number?: string | null;
  dispatch_route?: string | null;
  dispatch_instructions?: string | null;
  driver_name?: string | null;
  vehicle_number?: string | null;
  freight_cost?: number | null;
  freight_currency?: string | null;
  ready_at?: string | null;
  dispatched_at?: string | null;
  delivered_at?: string | null;
  items?: Array<{
    id: string;
    description: string;
    quantity_ordered: number;
    quantity_delivered: number;
    product?: { name: string } | null;
  }>;
}

interface Props {
  dn: DeliveryLogisticsDN;
  onChanged?: () => void;
}

const FINAL_STATUSES = FINAL_DELIVERY_STATUSES;

export function DeliveryLogisticsPanel({ dn, onChanged }: Props) {
  const { carriers } = useCarriers();
  const events = useDeliveryNoteEvents(dn.id);
  const proofs = useDeliveryProofs(dn.id);

  const markReady = useMarkDeliveryReady(dn.id);
  const dispatch = useDispatchDelivery(dn.id);
  const complete = useCompleteDelivery(dn.id);
  const updateLogistics = useUpdateDeliveryLogistics(dn.id);

  const [logisticsOpen, setLogisticsOpen] = useState(false);
  const [timelineOpen, setTimelineOpen] = useState(true);
  const [podOpen, setPodOpen] = useState(false);
  const [showPartial, setShowPartial] = useState(false);
  const [receivedBy, setReceivedBy] = useState("");
  const [podNotes, setPodNotes] = useState("");

  const [form, setForm] = useState<Record<string, any>>({
    shipping_method: dn.shipping_method ?? "",
    carrier_id: dn.carrier_id ?? "",
    tracking_number: dn.tracking_number ?? "",
    driver_name: dn.driver_name ?? "",
    vehicle_number: dn.vehicle_number ?? "",
    dispatch_route: dn.dispatch_route ?? "",
    dispatch_instructions: dn.dispatch_instructions ?? "",
    freight_cost: dn.freight_cost ?? "",
    freight_currency: dn.freight_currency ?? "",
  });

  const partialItems: PartialItem[] = useMemo(
    () => (dn.items ?? []).map((i) => ({
      id: i.id,
      name: i.product?.name || i.description,
      quantity_ordered: Number(i.quantity_ordered),
      quantity_delivered: Number(i.quantity_delivered),
    })),
    [dn.items],
  );

  const isFinal = FINAL_STATUSES.has(dn.status as DeliveryNoteStatus);
  const canMarkReady = dn.status === "pending";
  const canDispatch = dn.status === "pending" || dn.status === "ready_to_dispatch";
  const canComplete = !isFinal;

  const handleSaveLogistics = async () => {
    await updateLogistics.mutateAsync({
      id: dn.id,
      payload: Object.fromEntries(
        Object.entries(form).map(([k, v]) => [k, v === "" ? null : v]),
      ),
    });
    onChanged?.();
  };

  const handleDispatch = async () => {
    await dispatch.mutateAsync({
      id: dn.id,
      payload: Object.fromEntries(
        Object.entries(form).filter(([, v]) => v !== "" && v != null),
      ),
    });
    onChanged?.();
  };

  const handleComplete = async () => {
    const pod = (receivedBy || podNotes)
      ? { received_by_name: receivedBy || undefined, notes: podNotes || undefined }
      : null;
    await complete.mutateAsync({ id: dn.id, received_by: receivedBy || undefined, pod });
    onChanged?.();
  };

  return (
    <>
      {/* Lifecycle actions */}
      {!isFinal && (
        <div className="flex flex-wrap gap-2">
          {canMarkReady && (
            <Button size="sm" variant="outline" onClick={() => markReady.mutate(dn.id)} disabled={markReady.isPending}>
              <Package className="h-4 w-4 mr-2" />
              Mark ready
            </Button>
          )}
          {canDispatch && (
            <Button size="sm" variant="outline" onClick={handleDispatch} disabled={dispatch.isPending}>
              <Truck className="h-4 w-4 mr-2" />
              {dispatch.isPending ? "Dispatching…" : "Dispatch"}
            </Button>
          )}
          {canComplete && (
            <>
              <Button size="sm" onClick={handleComplete} disabled={complete.isPending}>
                <CheckCircle className="h-4 w-4 mr-2" />
                {complete.isPending ? "Releasing stock…" : "Complete delivery"}
              </Button>
              <Button size="sm" variant="outline" onClick={() => setShowPartial(true)}>
                <PackageCheck className="h-4 w-4 mr-2" />
                Record partial
              </Button>
            </>
          )}
        </div>
      )}

      {/* Logistics block */}
      <Collapsible open={logisticsOpen} onOpenChange={setLogisticsOpen}>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" className="w-full justify-between px-2">
            <span className="flex items-center gap-2 text-sm font-medium">
              <Truck className="h-4 w-4" /> Logistics
            </span>
            <ChevronDown className={`h-4 w-4 transition-transform ${logisticsOpen ? "rotate-180" : ""}`} />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-3 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Shipping method</Label>
              <Select value={form.shipping_method || ""} onValueChange={(v) => setForm({ ...form, shipping_method: v })}>
                <SelectTrigger><SelectValue placeholder="Select…" /></SelectTrigger>
                <SelectContent>
                  {SHIPPING_METHODS.map((m) => <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Carrier</Label>
              <Select value={form.carrier_id || ""} onValueChange={(v) => setForm({ ...form, carrier_id: v })}>
                <SelectTrigger><SelectValue placeholder="None" /></SelectTrigger>
                <SelectContent>
                  {carriers.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                  <div className="px-2 py-1.5 border-t mt-1">
                    <Link
                      to="/settings/carriers"
                      className="text-xs text-primary hover:underline"
                    >
                      Manage carriers →
                    </Link>
                  </div>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Tracking #</Label>
              <Input value={form.tracking_number || ""} onChange={(e) => setForm({ ...form, tracking_number: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Driver</Label>
              <Input value={form.driver_name || ""} onChange={(e) => setForm({ ...form, driver_name: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Vehicle #</Label>
              <Input value={form.vehicle_number || ""} onChange={(e) => setForm({ ...form, vehicle_number: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Route</Label>
              <Input value={form.dispatch_route || ""} onChange={(e) => setForm({ ...form, dispatch_route: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Freight cost</Label>
              <Input type="number" step="0.01" value={form.freight_cost ?? ""}
                onChange={(e) => setForm({ ...form, freight_cost: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Freight currency</Label>
              <Input value={form.freight_currency || ""} onChange={(e) => setForm({ ...form, freight_currency: e.target.value })} />
            </div>
            <div className="space-y-1 col-span-2">
              <Label className="text-xs">Dispatch instructions</Label>
              <Textarea value={form.dispatch_instructions || ""} rows={2}
                onChange={(e) => setForm({ ...form, dispatch_instructions: e.target.value })} />
            </div>
          </div>
          <div className="flex justify-end">
            <Button size="sm" variant="outline" onClick={handleSaveLogistics} disabled={updateLogistics.isPending}>
              {updateLogistics.isPending ? "Saving…" : "Save logistics"}
            </Button>
          </div>
        </CollapsibleContent>
      </Collapsible>

      <Separator />

      {/* Lifecycle timeline */}
      <Collapsible open={timelineOpen} onOpenChange={setTimelineOpen}>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" className="w-full justify-between px-2">
            <span className="flex items-center gap-2 text-sm font-medium">
              <Clock className="h-4 w-4" /> Lifecycle timeline
            </span>
            <ChevronDown className={`h-4 w-4 transition-transform ${timelineOpen ? "rotate-180" : ""}`} />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-3">
          {events.isLoading ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" /> Loading…
            </div>
          ) : (events.data ?? []).length === 0 ? (
            <p className="text-xs text-muted-foreground">No lifecycle events yet.</p>
          ) : (
            <ol className="space-y-2 border-l pl-4">
              {(events.data ?? []).map((e) => (
                <li key={e.id} className="text-xs">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="text-[10px]">{EVENT_LABEL[e.event_type] ?? e.event_type}</Badge>
                    <span className="text-muted-foreground">
                      {format(parseISO(e.occurred_at), "MMM d, yyyy HH:mm")}
                    </span>
                  </div>
                  {e.notes && <p className="text-muted-foreground mt-1">{e.notes}</p>}
                </li>
              ))}
            </ol>
          )}
        </CollapsibleContent>
      </Collapsible>

      <Separator />

      {/* Proof of delivery */}
      <Collapsible open={podOpen} onOpenChange={setPodOpen}>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" className="w-full justify-between px-2">
            <span className="flex items-center gap-2 text-sm font-medium">
              <ClipboardSignature className="h-4 w-4" /> Proof of Delivery
            </span>
            <ChevronDown className={`h-4 w-4 transition-transform ${podOpen ? "rotate-180" : ""}`} />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-3 space-y-3">
          {!isFinal && (
            <div className="space-y-2">
              <div className="space-y-1">
                <Label className="text-xs">Received by (name)</Label>
                <Input value={receivedBy} onChange={(e) => setReceivedBy(e.target.value)} placeholder="Recipient name" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">POD notes</Label>
                <Textarea value={podNotes} onChange={(e) => setPodNotes(e.target.value)} rows={2} />
              </div>
              <p className="text-[11px] text-muted-foreground">
                Click <strong>Complete delivery</strong> above to release stock and record this proof in one transaction.
              </p>
            </div>
          )}
          {(proofs.data ?? []).length > 0 ? (
            <div className="space-y-2">
              {(proofs.data ?? []).map((p) => (
                <div key={p.id} className="rounded border p-2 text-xs space-y-1">
                  <div className="flex justify-between">
                    <span className="font-medium">{p.received_by_name || "Unsigned"}</span>
                    <span className="text-muted-foreground">{format(parseISO(p.received_at), "MMM d, HH:mm")}</span>
                  </div>
                  {p.notes && <p className="text-muted-foreground">{p.notes}</p>}
                </div>
              ))}
            </div>
          ) : (
            isFinal && <p className="text-xs text-muted-foreground">No proof of delivery recorded.</p>
          )}
        </CollapsibleContent>
      </Collapsible>

      <PartialDeliveryDialog
        open={showPartial}
        onOpenChange={setShowPartial}
        deliveryNoteId={dn.id}
        items={partialItems}
        onDone={onChanged}
      />
    </>
  );
}