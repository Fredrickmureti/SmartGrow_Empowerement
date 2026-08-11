import { normalizeError } from "@/services/resilience";
/**
 * Vendor Portal - Purchase Order Detail View
 * Full document view with line items, totals, and acknowledgment
 */
import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useVendorPortal } from "@/hooks/useVendorPortal";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  ArrowLeft, CheckCircle, Package, Calendar, MapPin, FileText, Loader2,
} from "lucide-react";
import { toast } from "sonner";

interface POItem {
  id: string;
  description: string;
  quantity: number;
  unit_price: number;
  tax_rate: number | null;
  tax_amount: number | null;
  line_total: number;
  quantity_received: number | null;
}

interface PODetail {
  id: string;
  po_number: string;
  status: string;
  order_date: string;
  expected_date: string | null;
  total: number;
  subtotal: number;
  tax_amount: number;
  currency: string;
  notes: string | null;
  shipping_address: string | null;
  vendor_confirmed_at: string | null;
  vendor_notes: string | null;
}

export default function VendorPODetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { portalData } = useVendorPortal();
  const [po, setPO] = useState<PODetail | null>(null);
  const [items, setItems] = useState<POItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isConfirming, setIsConfirming] = useState(false);
  const [vendorNotes, setVendorNotes] = useState("");

  useEffect(() => {
    if (id && portalData.contactId) fetchPODetail();
  }, [id, portalData.contactId]);

  const fetchPODetail = async () => {
    if (!id) return;
    setIsLoading(true);

    const [poResult, itemsResult] = await Promise.all([
      supabase
        .from("purchase_orders")
        .select("id, po_number, status, order_date, expected_date, total, subtotal, tax_amount, currency, notes, shipping_address, vendor_confirmed_at, vendor_notes")
        .eq("id", id)
        .single(),
      supabase
        .from("purchase_order_items")
        .select("id, description, quantity, unit_price, tax_rate, tax_amount, line_total, quantity_received")
        .eq("purchase_order_id", id)
        .order("sort_order", { ascending: true }),
    ]);

    if (poResult.data) {
      setPO(poResult.data as PODetail);
      setVendorNotes(poResult.data.vendor_notes || "");
    }
    if (itemsResult.data) {
      setItems(itemsResult.data as POItem[]);
    }
    setIsLoading(false);
  };

  const handleConfirmPO = async () => {
    if (!id) return;
    setIsConfirming(true);

    // Acknowledgement is a state-machine transition, not a column write.
    // The RPC stamps vendor_confirmed_at, stores the notes and emits
    // procurement.po.acknowledged. ("confirmed" was never a real status.)
    const { error } = await supabase.rpc("acknowledge_purchase_order" as any, {
      p_po_id: id,
      p_vendor_notes: vendorNotes || null,
    });

    if (error) {
      toast.error("Failed to confirm PO: " + normalizeError(error).message);
    } else {
      toast.success("Purchase order confirmed successfully");
      fetchPODetail();

      // Send notification to the business (fire-and-forget)
      supabase.functions.invoke("notify-po-confirmed", {
        body: { purchase_order_id: id },
      }).catch((err) => {
        console.warn("Failed to send PO confirmation notification:", err);
      });
    }
    setIsConfirming(false);
  };

  const statusColor: Record<string, "default" | "secondary" | "destructive"> = {
    draft: "secondary",
    submitted: "secondary",
    approved: "default",
    sent: "default",
    acknowledged: "default",
    partial_received: "default",
    received: "default",
    closed: "secondary",
    revised: "secondary",
    rejected: "destructive",
    cancelled: "destructive",
  };

  const formatCurrency = (amount: number) => {
    return `${po?.currency || "USD"} ${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; // architecture-allow: display-only fallback
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!po) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" onClick={() => navigate("/vendor-portal/purchase-orders")}>
          <ArrowLeft className="h-4 w-4 mr-2" /> Back to Purchase Orders
        </Button>
        <p className="text-muted-foreground">Purchase order not found.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Back + Header */}
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="sm" onClick={() => navigate("/vendor-portal/purchase-orders")}>
          <ArrowLeft className="h-4 w-4 mr-2" /> Back
        </Button>
      </div>

      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-foreground">{po.po_number}</h2>
          <p className="text-sm text-muted-foreground mt-1">
            From {portalData.organizationName || "Organization"}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Badge variant={statusColor[po.status] || "secondary"} className="text-sm">
            {po.status}
          </Badge>
          {po.vendor_confirmed_at && (
            <Badge variant="default" className="bg-green-600 text-sm">
              <CheckCircle className="h-3 w-3 mr-1" /> Confirmed
            </Badge>
          )}
        </div>
      </div>

      {/* PO Info Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card>
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
              <Calendar className="h-4 w-4" /> Order Date
            </div>
            <p className="font-medium">{new Date(po.order_date).toLocaleDateString()}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
              <Package className="h-4 w-4" /> Expected Delivery
            </div>
            <p className="font-medium">
              {po.expected_date ? new Date(po.expected_date).toLocaleDateString() : "Not specified"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
              <MapPin className="h-4 w-4" /> Shipping Address
            </div>
            <p className="font-medium text-sm">{po.shipping_address || "Not specified"}</p>
          </CardContent>
        </Card>
      </div>

      {/* Notes from buyer */}
      {po.notes && (
        <Card>
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground mb-2">
              <FileText className="h-4 w-4" /> Notes from Buyer
            </div>
            <p className="text-sm">{po.notes}</p>
          </CardContent>
        </Card>
      )}

      {/* Line Items */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Order Items</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[40%]">Description</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Unit Price</TableHead>
                <TableHead className="text-right">Tax</TableHead>
                <TableHead className="text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell className="font-medium">{item.description}</TableCell>
                  <TableCell className="text-right">{item.quantity}</TableCell>
                  <TableCell className="text-right">{formatCurrency(item.unit_price)}</TableCell>
                  <TableCell className="text-right">
                    {item.tax_amount != null ? formatCurrency(item.tax_amount) : "—"}
                  </TableCell>
                  <TableCell className="text-right font-medium">{formatCurrency(item.line_total)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Totals */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex flex-col items-end space-y-2">
            <div className="flex justify-between w-full max-w-xs text-sm">
              <span className="text-muted-foreground">Subtotal</span>
              <span>{formatCurrency(po.subtotal)}</span>
            </div>
            <div className="flex justify-between w-full max-w-xs text-sm">
              <span className="text-muted-foreground">Tax</span>
              <span>{formatCurrency(po.tax_amount)}</span>
            </div>
            <Separator className="w-full max-w-xs" />
            <div className="flex justify-between w-full max-w-xs font-bold text-lg">
              <span>Total</span>
              <span>{formatCurrency(po.total)}</span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Confirm / Acknowledge */}
      {!po.vendor_confirmed_at && po.status !== "cancelled" && po.status !== "draft" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Confirm Purchase Order</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Confirm that you have received and reviewed this purchase order. You may add any notes below.
            </p>
            <Textarea
              placeholder="Optional notes (e.g., delivery timeline, special requirements...)"
              value={vendorNotes}
              onChange={(e) => setVendorNotes(e.target.value)}
              rows={3}
            />
            <Button onClick={handleConfirmPO} disabled={isConfirming}>
              {isConfirming ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <CheckCircle className="h-4 w-4 mr-2" />
              )}
              Confirm Purchase Order
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Already confirmed */}
      {po.vendor_confirmed_at && (
        <Card className="border-green-200 dark:border-green-800">
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-green-600">
              <CheckCircle className="h-5 w-5" />
              <span className="font-medium">
                Confirmed on {new Date(po.vendor_confirmed_at).toLocaleDateString()}
              </span>
            </div>
            {po.vendor_notes && (
              <p className="text-sm text-muted-foreground mt-2">Your notes: {po.vendor_notes}</p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
