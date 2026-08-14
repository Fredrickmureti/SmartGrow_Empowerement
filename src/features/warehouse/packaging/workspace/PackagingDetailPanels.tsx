/**
 * Packaging Master — detail panels (carrier rules, warehouse availability,
 * activity). Every write goes through the sanctioned RPC seam.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, LoadingState, StatusBadge } from "@/design-system";
import { Truck, Warehouse as WarehouseIcon, History } from "lucide-react";
import { useWarehouses } from "@/hooks/useWarehouses";
import {
  packagingErrorMessage,
  usePackagingAvailability,
  usePackagingCarrierRules,
  usePackagingEvents,
  useSetPackagingAvailability,
  useSetPackagingCarrierRule,
} from "../packagingMaster";

interface PanelProps {
  packagingTypeId: string;
  businessId?: string;
  readOnly?: boolean;
}

function useCarriers(businessId?: string) {
  return useQuery({
    queryKey: ["wms-carriers-lite", businessId],
    enabled: !!businessId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("carriers")
        .select("id,name")
        .eq("business_id", businessId!)
        .eq("is_active", true)
        .order("name");
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function PackagingCarriersPanel({ packagingTypeId, businessId, readOnly }: PanelProps) {
  const { data: rules, isLoading } = usePackagingCarrierRules(packagingTypeId);
  const { data: carriers } = useCarriers(businessId);
  const setRule = useSetPackagingCarrierRule();

  const [carrierId, setCarrierId] = useState("");
  const [serviceCode, setServiceCode] = useState("");
  const [isAllowed, setIsAllowed] = useState(true);
  const [isOversize, setIsOversize] = useState(false);
  const [surcharge, setSurcharge] = useState("0");

  const nameOf = (id: string) => carriers?.find((c) => c.id === id)?.name ?? id.slice(0, 8);

  const submit = () => {
    if (!carrierId) return;
    setRule.mutate(
      {
        packagingTypeId,
        carrierId,
        serviceCode: serviceCode.trim() || null,
        isAllowed,
        isOversize,
        surchargeAmount: Number(surcharge) || 0,
      },
      {
        onSuccess: () => {
          toast.success("Carrier rule saved");
          setCarrierId("");
          setServiceCode("");
        },
        onError: (e) => toast.error(packagingErrorMessage(e)),
      },
    );
  };

  if (isLoading) return <LoadingState rows={3} />;

  return (
    <div className="space-y-4">
      {!rules?.length ? (
        <EmptyState
          icon={Truck}
          title="No carrier rules"
          description="Without a rule, this packaging is offered to every carrier."
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Carrier</TableHead>
              <TableHead>Service</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Surcharge</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rules.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="font-medium">{nameOf(r.carrier_id)}</TableCell>
                <TableCell className="text-muted-foreground">{r.service_code ?? "Any"}</TableCell>
                <TableCell className="space-x-1">
                  <StatusBadge tone={r.is_allowed ? "success" : "danger"}>
                    {r.is_allowed ? "Allowed" : "Blocked"}
                  </StatusBadge>
                  {r.is_oversize ? <StatusBadge tone="warning">Oversize</StatusBadge> : null}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {Number(r.surcharge_amount ?? 0).toFixed(2)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {!readOnly && (
        <div className="min-w-0 grid gap-3 rounded-lg border p-4 @xl/page:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Carrier</Label>
            <Select value={carrierId} onValueChange={setCarrierId}>
              <SelectTrigger><SelectValue placeholder="Select carrier" /></SelectTrigger>
              <SelectContent>
                {carriers?.map((c) => (
                  <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Service code</Label>
            <Input value={serviceCode} onChange={(e) => setServiceCode(e.target.value)} placeholder="Any" />
          </div>
          <div className="space-y-1.5">
            <Label>Surcharge</Label>
            <Input type="number" step="0.01" value={surcharge} onChange={(e) => setSurcharge(e.target.value)} />
          </div>
          <div className="flex items-end gap-6">
            <div className="flex items-center gap-2">
              <Switch checked={isAllowed} onCheckedChange={setIsAllowed} id="rule-allowed" />
              <Label htmlFor="rule-allowed">Allowed</Label>
            </div>
            <div className="flex items-center gap-2">
              <Switch checked={isOversize} onCheckedChange={setIsOversize} id="rule-oversize" />
              <Label htmlFor="rule-oversize">Oversize</Label>
            </div>
          </div>
          <div className="min-w-0 @xl/page:col-span-2">
            <Button onClick={submit} disabled={!carrierId || setRule.isPending}>
              Save carrier rule
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export function PackagingAvailabilityPanel({ packagingTypeId, readOnly }: PanelProps) {
  const { data: rows, isLoading } = usePackagingAvailability(packagingTypeId);
  const { warehouses } = useWarehouses();
  const setAvailability = useSetPackagingAvailability();

  const [warehouseId, setWarehouseId] = useState("");
  const [qty, setQty] = useState("");
  const [reorder, setReorder] = useState("");
  const [stocked, setStocked] = useState(true);

  const nameOf = (id: string) => warehouses?.find((w) => w.id === id)?.name ?? id.slice(0, 8);

  const submit = () => {
    if (!warehouseId) return;
    setAvailability.mutate(
      {
        packagingTypeId,
        warehouseId,
        qtyOnHand: qty === "" ? null : Number(qty),
        reorderPoint: reorder === "" ? null : Number(reorder),
        isStocked: stocked,
      },
      {
        onSuccess: () => {
          toast.success("Stock position updated");
          setQty("");
          setReorder("");
        },
        onError: (e) => toast.error(packagingErrorMessage(e)),
      },
    );
  };

  if (isLoading) return <LoadingState rows={3} />;

  return (
    <div className="space-y-4">
      {!rows?.length ? (
        <EmptyState
          icon={WarehouseIcon}
          title="Not stocked anywhere"
          description="Cartonization can still choose it unless stock is required."
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Warehouse</TableHead>
              <TableHead className="text-right">On hand (pieces)</TableHead>
              <TableHead className="text-right">Reorder point (pieces)</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="font-medium">{nameOf(r.warehouse_id)}</TableCell>
                <TableCell className="text-right tabular-nums">{`${Number(r.qty_on_hand ?? 0).toLocaleString()} pcs`}</TableCell>
                <TableCell className="text-right tabular-nums">{`${Number(r.reorder_point ?? 0).toLocaleString()} pcs`}</TableCell>
                <TableCell>
                  <StatusBadge
                    tone={!r.is_stocked ? "neutral" : r.qty_on_hand <= r.reorder_point ? "warning" : "success"}
                  >
                    {!r.is_stocked
                      ? "Not stocked"
                      : r.qty_on_hand <= r.reorder_point
                        ? "Below reorder"
                        : "In stock"}
                  </StatusBadge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {!readOnly && (
        <div className="min-w-0 grid gap-3 rounded-lg border p-4 @xl/page:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Warehouse</Label>
            <Select value={warehouseId} onValueChange={setWarehouseId}>
              <SelectTrigger><SelectValue placeholder="Select warehouse" /></SelectTrigger>
              <SelectContent>
                {warehouses?.map((w) => (
                  <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-end gap-2">
            <Switch checked={stocked} onCheckedChange={setStocked} id="avail-stocked" />
            <Label htmlFor="avail-stocked">Stocked here</Label>
          </div>
          <div className="space-y-1.5">
            <Label>Counted quantity</Label>
            <Input type="number" value={qty} onChange={(e) => setQty(e.target.value)} placeholder="Leave blank to keep" />
          </div>
          <div className="space-y-1.5">
            <Label>Reorder point</Label>
            <Input type="number" value={reorder} onChange={(e) => setReorder(e.target.value)} placeholder="Leave blank to keep" />
          </div>
          <div className="min-w-0 @xl/page:col-span-2">
            <Button onClick={submit} disabled={!warehouseId || setAvailability.isPending}>
              Save stock position
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export function PackagingActivityPanel({ packagingTypeId }: PanelProps) {
  const { data, isLoading } = usePackagingEvents(packagingTypeId);
  if (isLoading) return <LoadingState rows={3} />;
  if (!data?.length)
    return <EmptyState icon={History} title="No activity yet" description="Every master change is journalled here." />;

  return (
    <ol className="space-y-3">
      {data.map((e) => (
        <li key={e.id} className="flex items-start gap-3 border-b pb-3 last:border-0">
          <StatusBadge tone="info">{e.event_type.replace(/_/g, " ")}</StatusBadge>
          <div className="min-w-0 flex-1 text-sm">
            {e.from_status || e.to_status ? (
              <p>{e.from_status ?? "—"} → {e.to_status ?? "—"}</p>
            ) : null}
            {e.qty_delta != null ? <p>Quantity delta {e.qty_delta}</p> : null}
            {e.reason ? <p className="text-muted-foreground">{e.reason}</p> : null}
          </div>
          <span className="whitespace-nowrap text-xs text-muted-foreground">
            {new Date(e.created_at).toLocaleString()}
          </span>
        </li>
      ))}
    </ol>
  );
}
