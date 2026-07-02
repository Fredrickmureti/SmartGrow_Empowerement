import { normalizeError } from "@/services/resilience";
/**
 * Vendor Portal - RFQ Detail & Response View
 * Allows vendors to view RFQ items and submit per-item pricing
 */
import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useVendorPortal } from "@/hooks/useVendorPortal";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  ArrowLeft, Send, Clock, AlertTriangle, CheckCircle, Loader2,
} from "lucide-react";
import { toast } from "sonner";

interface RFQItem {
  id: string;
  description: string;
  quantity: number;
  target_price: number | null;
  product_id: string | null;
}

interface VendorItemQuote {
  rfq_item_id: string;
  unit_price: number | null;
  available_qty: number | null;
}

interface RFQHeader {
  id: string;
  rfq_number: string;
  status: string;
  deadline: string | null;
  notes: string | null;
}

interface RFQVendorEntry {
  id: string;
  status: string;
  quoted_total: number | null;
  lead_time_days: number | null;
  notes: string | null;
  responded_at: string | null;
}

export default function VendorRFQDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { portalData } = useVendorPortal();

  const [rfq, setRfq] = useState<RFQHeader | null>(null);
  const [rfqVendor, setRfqVendor] = useState<RFQVendorEntry | null>(null);
  const [items, setItems] = useState<RFQItem[]>([]);
  const [quotes, setQuotes] = useState<Record<string, VendorItemQuote>>({});
  const [leadTimeDays, setLeadTimeDays] = useState<string>("");
  const [vendorNotes, setVendorNotes] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (id && portalData.contactId) fetchRFQDetail();
  }, [id, portalData.contactId]);

  const fetchRFQDetail = async () => {
    if (!id || !portalData.contactId) return;
    setIsLoading(true);

    // id here is the rfq_vendor id from the list
    const { data: rvData } = await supabase
      .from("rfq_vendors")
      .select("id, status, quoted_total, lead_time_days, notes, responded_at, rfq_id")
      .eq("id", id)
      .single();

    if (!rvData) {
      setIsLoading(false);
      return;
    }

    setRfqVendor({
      id: rvData.id,
      status: rvData.status,
      quoted_total: rvData.quoted_total,
      lead_time_days: rvData.lead_time_days,
      notes: rvData.notes,
      responded_at: rvData.responded_at,
    });
    setLeadTimeDays(rvData.lead_time_days?.toString() || "");
    setVendorNotes(rvData.notes || "");

    const rfqId = rvData.rfq_id;

    const [rfqResult, itemsResult, vendorItemsResult] = await Promise.all([
      supabase.from("rfqs").select("id, rfq_number, status, deadline, notes").eq("id", rfqId).single(),
      supabase.from("rfq_items").select("id, description, quantity, target_price, product_id").eq("rfq_id", rfqId).order("sort_order"),
      (supabase as any).from("rfq_vendor_items").select("rfq_item_id, unit_price, available_qty").eq("rfq_vendor_id", rvData.id),
    ]);

    if (rfqResult.data) setRfq(rfqResult.data as RFQHeader);

    if (itemsResult.data) setItems(itemsResult.data as RFQItem[]);

    // Build quotes map
    const quotesMap: Record<string, VendorItemQuote> = {};
    if (itemsResult.data) {
      (itemsResult.data as RFQItem[]).forEach((item) => {
        quotesMap[item.id] = { rfq_item_id: item.id, unit_price: null, available_qty: null };
      });
    }
    if (vendorItemsResult.data) {
      (vendorItemsResult.data as any[]).forEach((vi: any) => {
        quotesMap[vi.rfq_item_id] = {
          rfq_item_id: vi.rfq_item_id,
          unit_price: vi.unit_price,
          available_qty: vi.available_qty,
        };
      });
    }
    setQuotes(quotesMap);
    setIsLoading(false);
  };

  const updateQuote = (itemId: string, field: "unit_price" | "available_qty", value: string) => {
    setQuotes((prev) => ({
      ...prev,
      [itemId]: {
        ...prev[itemId],
        [field]: value === "" ? null : Number(value),
      },
    }));
  };

  const calculateTotal = () => {
    return items.reduce((sum, item) => {
      const quote = quotes[item.id];
      if (quote?.unit_price != null) {
        const qty = quote.available_qty ?? item.quantity;
        return sum + quote.unit_price * qty;
      }
      return sum;
    }, 0);
  };

  const handleSubmitQuote = async () => {
    if (!rfqVendor) return;
    setIsSubmitting(true);

    try {
      // Delete existing vendor items and re-insert
      await (supabase as any)
        .from("rfq_vendor_items")
        .delete()
        .eq("rfq_vendor_id", rfqVendor.id);

      const itemsToInsert = Object.values(quotes)
        .filter((q) => q.unit_price != null)
        .map((q) => ({
          rfq_vendor_id: rfqVendor.id,
          rfq_item_id: q.rfq_item_id,
          unit_price: q.unit_price,
          available_qty: q.available_qty,
        }));

      if (itemsToInsert.length > 0) {
        const { error: insertErr } = await (supabase as any)
          .from("rfq_vendor_items")
          .insert(itemsToInsert);
        if (insertErr) throw insertErr;
      }

      // Update rfq_vendors record
      const { error: updateErr } = await supabase
        .from("rfq_vendors")
        .update({
          status: "quoted",
          quoted_total: calculateTotal(),
          lead_time_days: leadTimeDays ? parseInt(leadTimeDays) : null,
          notes: vendorNotes || null,
          responded_at: new Date().toISOString(),
        })
        .eq("id", rfqVendor.id);

      if (updateErr) throw updateErr;

      toast.success("Quote submitted successfully");
      fetchRFQDetail();
    } catch (err: any) {
      toast.error("Failed to submit quote: " + normalizeError(err).message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const isDeadlinePassed = rfq?.deadline ? new Date(rfq.deadline) < new Date() : false;
  const isDeadlineSoon = rfq?.deadline
    ? new Date(rfq.deadline).getTime() - Date.now() < 48 * 60 * 60 * 1000 && !isDeadlinePassed
    : false;
  const isAlreadyQuoted = rfqVendor?.status === "quoted";
  const canSubmit = !isDeadlinePassed && rfq?.status !== "closed" && rfq?.status !== "cancelled";

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!rfq || !rfqVendor) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" onClick={() => navigate("/vendor-portal/rfqs")}>
          <ArrowLeft className="h-4 w-4 mr-2" /> Back to RFQs
        </Button>
        <p className="text-muted-foreground">RFQ not found.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="sm" onClick={() => navigate("/vendor-portal/rfqs")}>
          <ArrowLeft className="h-4 w-4 mr-2" /> Back
        </Button>
      </div>

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-foreground">{rfq.rfq_number}</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Request for Quotation from {portalData.organizationName || "Organization"}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Badge variant="secondary">{rfq.status}</Badge>
          <Badge variant={rfqVendor.status === "pending" ? "destructive" : "default"}>
            {rfqVendor.status}
          </Badge>
        </div>
      </div>

      {/* Deadline warning */}
      {isDeadlinePassed && (
        <Card className="border-destructive">
          <CardContent className="pt-4 pb-4 flex items-center gap-2 text-destructive">
            <AlertTriangle className="h-5 w-5" />
            <span className="font-medium">Deadline has passed. Submissions are closed.</span>
          </CardContent>
        </Card>
      )}
      {isDeadlineSoon && (
        <Card className="border-orange-300 dark:border-orange-700">
          <CardContent className="pt-4 pb-4 flex items-center gap-2 text-orange-600">
            <Clock className="h-5 w-5" />
            <span className="font-medium">
              Deadline approaching: {new Date(rfq.deadline!).toLocaleString()}
            </span>
          </CardContent>
        </Card>
      )}

      {/* RFQ Info */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Card>
          <CardContent className="pt-4 pb-4">
            <p className="text-sm text-muted-foreground">Deadline</p>
            <p className="font-medium">
              {rfq.deadline ? new Date(rfq.deadline).toLocaleString() : "No deadline"}
            </p>
          </CardContent>
        </Card>
        {rfq.notes && (
          <Card>
            <CardContent className="pt-4 pb-4">
              <p className="text-sm text-muted-foreground">Notes from Buyer</p>
              <p className="text-sm mt-1">{rfq.notes}</p>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Already submitted confirmation */}
      {isAlreadyQuoted && rfqVendor.responded_at && (
        <Card className="border-green-200 dark:border-green-800">
          <CardContent className="pt-4 pb-4 flex items-center gap-2 text-green-600">
            <CheckCircle className="h-5 w-5" />
            <span className="font-medium">
              Quote submitted on {new Date(rfqVendor.responded_at).toLocaleDateString()}
              {rfqVendor.quoted_total != null && ` — Total: ${rfqVendor.quoted_total.toLocaleString()}`}
            </span>
          </CardContent>
        </Card>
      )}

      {/* Items & Quote Form */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">
            {canSubmit ? "Requested Items — Enter Your Quote" : "Requested Items"}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[30%]">Description</TableHead>
                  <TableHead className="text-right">Requested Qty</TableHead>
                  <TableHead className="text-right">Target Price</TableHead>
                  <TableHead className="text-right">Your Unit Price</TableHead>
                  <TableHead className="text-right">Available Qty</TableHead>
                  <TableHead className="text-right">Line Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => {
                  const quote = quotes[item.id];
                  const lineTotal =
                    quote?.unit_price != null
                      ? quote.unit_price * (quote.available_qty ?? item.quantity)
                      : 0;

                  return (
                    <TableRow key={item.id}>
                      <TableCell className="font-medium">{item.description}</TableCell>
                      <TableCell className="text-right">{item.quantity}</TableCell>
                      <TableCell className="text-right">
                        {item.target_price != null ? item.target_price.toLocaleString() : "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        {canSubmit ? (
                          <Input
                            type="number"
                            min="0"
                            step="0.01"
                            className="w-28 ml-auto text-right"
                            placeholder="0.00"
                            value={quote?.unit_price ?? ""}
                            onChange={(e) => updateQuote(item.id, "unit_price", e.target.value)}
                          />
                        ) : (
                          <span>{quote?.unit_price?.toLocaleString() ?? "—"}</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {canSubmit ? (
                          <Input
                            type="number"
                            min="0"
                            className="w-24 ml-auto text-right"
                            placeholder={String(item.quantity)}
                            value={quote?.available_qty ?? ""}
                            onChange={(e) => updateQuote(item.id, "available_qty", e.target.value)}
                          />
                        ) : (
                          <span>{quote?.available_qty ?? item.quantity}</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right font-medium">
                        {lineTotal > 0 ? lineTotal.toLocaleString(undefined, { minimumFractionDigits: 2 }) : "—"}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* Totals & Submit */}
      {canSubmit && (
        <Card>
          <CardContent className="pt-6 space-y-4">
            <div className="flex flex-col items-end">
              <div className="flex justify-between w-full max-w-xs font-bold text-lg">
                <span>Quoted Total</span>
                <span>{calculateTotal().toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
              </div>
            </div>

            <Separator />

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Lead Time (days)</Label>
                <Input
                  type="number"
                  min="0"
                  placeholder="e.g., 14"
                  value={leadTimeDays}
                  onChange={(e) => setLeadTimeDays(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label>Notes</Label>
                <Textarea
                  placeholder="Any notes about availability, terms, etc."
                  value={vendorNotes}
                  onChange={(e) => setVendorNotes(e.target.value)}
                  rows={2}
                />
              </div>
            </div>

            <Button onClick={handleSubmitQuote} disabled={isSubmitting} className="w-full sm:w-auto">
              {isSubmitting ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Send className="h-4 w-4 mr-2" />
              )}
              {isAlreadyQuoted ? "Update Quote" : "Submit Quote"}
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
