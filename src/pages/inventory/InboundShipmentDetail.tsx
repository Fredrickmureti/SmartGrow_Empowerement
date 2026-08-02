/**
 * InboundShipmentDetail — single ASN header + lines with a
 * "Start Goods Receipt" launcher. When the ASN is linked to a PO,
 * the wizard prefills quantities, lots and expiry via the existing
 * PO → GRN → ASN contract; capture happens in the WMS receiving session.
 */
import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { format } from "date-fns";
import { ArrowLeft, Loader2, PackageCheck, Truck } from "lucide-react";

interface ShipmentDetail {
  id: string;
  shipment_number: string;
  status: string;
  carrier: string | null;
  tracking_number: string | null;
  dispatched_at: string | null;
  expected_arrival_at: string | null;
  notes: string | null;
  purchase_order_id: string | null;
  purchase_order?: { id: string; po_number: string } | null;
  items: Array<{
    id: string;
    product_id: string | null;
    product?: { name: string; sku: string | null } | null;
    expected_quantity: number;
    expected_lot_number: string | null;
    expected_expiry_date: string | null;
    expected_manufacture_date: string | null;
    notes: string | null;
    sort_order: number | null;
  }>;
}

const STATUS_VARIANTS: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  draft: "secondary",
  dispatched: "default",
  in_transit: "default",
  arrived: "outline",
  received: "default",
  cancelled: "destructive",
};

export default function InboundShipmentDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [shipment, setShipment] = useState<ShipmentDetail | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    const { data, error } = await supabase
      .from("inbound_shipments")
      .select(
        "id, shipment_number, status, carrier, tracking_number, dispatched_at, expected_arrival_at, notes, purchase_order_id, purchase_order:purchase_orders(id, po_number), items:inbound_shipment_items(id, product_id, expected_quantity, expected_lot_number, expected_expiry_date, expected_manufacture_date, notes, sort_order, product:products(name, sku))",
      )
      .eq("id", id)
      .maybeSingle();
    if (error) {
      toast({ title: "Failed to load shipment", description: error.message, variant: "destructive" });
      setShipment(null);
    } else {
      const s = data as unknown as ShipmentDetail | null;
      if (s?.items) s.items.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
      setShipment(s);
    }
    setLoading(false);
  }, [id, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!shipment) {
    return (
      <div className="py-16 text-center text-muted-foreground">
        <p>Shipment not found.</p>
        <Button variant="outline" className="mt-4" onClick={() => navigate("/inventory-app/inbound-shipments")}>
          Back to shipments
        </Button>
      </div>
    );
  }

  const canStartGrn =
    !!shipment.purchase_order_id &&
    !["received", "cancelled"].includes(shipment.status);

  const startGrn = () => {
    if (!shipment.purchase_order_id) return;
    navigate(
      `/warehouse-app/receiving?source_doc_type=purchase_order&source_doc_id=${shipment.purchase_order_id}`,
    );
  };

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="page-header">
        <div className="flex items-start gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate("/inventory-app/inbound-shipments")}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <div className="flex items-center gap-2">
              <Truck className="h-5 w-5 text-muted-foreground" />
              <h1 className="page-title font-mono">{shipment.shipment_number}</h1>
              <Badge variant={STATUS_VARIANTS[shipment.status] ?? "secondary"}>
                {shipment.status.replace("_", " ")}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground mt-1">
              {shipment.purchase_order
                ? <>Linked to PO <span className="font-mono">{shipment.purchase_order.po_number}</span></>
                : "No linked purchase order"}
            </p>
          </div>
        </div>
        <div className="action-buttons w-full sm:w-auto">
          <Button onClick={startGrn} disabled={!canStartGrn} title={!canStartGrn ? "Requires a linked PO in an active status" : undefined}>
            <PackageCheck className="mr-2 h-4 w-4" /> Start Goods Receipt
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Shipment info</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
          <div>
            <div className="text-xs text-muted-foreground">Carrier</div>
            <div>{shipment.carrier ?? "—"}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Tracking</div>
            <div className="font-mono text-xs">{shipment.tracking_number ?? "—"}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Dispatched</div>
            <div>{shipment.dispatched_at ? format(new Date(shipment.dispatched_at), "dd MMM yyyy") : "—"}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Expected arrival</div>
            <div>{shipment.expected_arrival_at ? format(new Date(shipment.expected_arrival_at), "dd MMM yyyy") : "—"}</div>
          </div>
          {shipment.notes && (
            <div className="col-span-2 sm:col-span-4">
              <div className="text-xs text-muted-foreground">Notes</div>
              <div className="whitespace-pre-wrap text-sm">{shipment.notes}</div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Expected lines ({shipment.items.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {shipment.items.length === 0 ? (
            <div className="text-sm text-muted-foreground py-6 text-center">No lines on this shipment.</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Product</TableHead>
                  <TableHead>SKU</TableHead>
                  <TableHead className="text-right">Expected qty</TableHead>
                  <TableHead>Lot</TableHead>
                  <TableHead>Mfg</TableHead>
                  <TableHead>Expiry</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shipment.items.map((it) => (
                  <TableRow key={it.id}>
                    <TableCell>{it.product?.name ?? "—"}</TableCell>
                    <TableCell className="font-mono text-xs">{it.product?.sku ?? "—"}</TableCell>
                    <TableCell className="text-right">{it.expected_quantity}</TableCell>
                    <TableCell className="font-mono text-xs">{it.expected_lot_number ?? "—"}</TableCell>
                    <TableCell className="text-xs">
                      {it.expected_manufacture_date ? format(new Date(it.expected_manufacture_date), "dd MMM yyyy") : "—"}
                    </TableCell>
                    <TableCell className="text-xs">
                      {it.expected_expiry_date ? format(new Date(it.expected_expiry_date), "dd MMM yyyy") : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
