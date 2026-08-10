import { normalizeError } from "@/services/resilience";
/**
 * Vendor Portal — RFQ invitation detail & quotation submission.
 *
 * The supplier never writes RFQ tables directly: the whole offer is posted
 * through `rfq_record_quotation`, which validates the invitation, pins the
 * RFQ version, computes totals server-side and supersedes the supplier's
 * previous quotation instead of mutating it. Re-quoting therefore produces
 * a new immutable version, which is what an audit needs.
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
import { BidAttachmentsPanel } from "@/features/purchases/rfqs/BidAttachmentsPanel";
import {
  AlternateProductPicker,
  type PortalProductOption,
} from "./AlternateProductPicker";


const db = supabase as any;

interface RFQItem {
  id: string;
  description: string;
  quantity: number;
  target_price: number | null;
  product_id: string | null;
}

interface LineQuote {
  rfq_item_id: string;
  unit_price: number | null;
  quoted_quantity: number | null;
  discount_percent: number | null;
  tax_rate: number | null;
  delivery_date: string | null;
  supplier_product_code: string | null;
  notes: string | null;
  /**
   * A structured substitute offer. When set, the buyer's comparison matrix
   * and any resulting PO line use this product instead of the requested one.
   */
  alternate_product: PortalProductOption | null;
}

/** Free-text line fields are stored verbatim; numeric fields are coerced. */
const TEXT_LINE_FIELDS = new Set<keyof LineQuote>([
  "delivery_date",
  "supplier_product_code",
  "notes",
]);

interface RFQHeader {
  id: string;
  rfq_number: string;
  status: string;
  deadline: string | null;
  notes: string | null;
  currency: string | null;
  version: number;
}

interface Invitation {
  id: string;
  rfq_id: string;
  rfq_version: number;
  invitation_state: string;
  response_deadline: string | null;
}

interface LiveQuotation {
  id: string;
  quotation_version: number;
  total: number;
  submitted_at: string;
  lead_time_days: number | null;
  incoterms: string | null;
  payment_terms: string | null;
  valid_until: string | null;
  notes: string | null;
  items: any[];
}

export default function VendorRFQDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { portalData, refreshRFQs } = useVendorPortal();

  const [rfq, setRfq] = useState<RFQHeader | null>(null);
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [quotation, setQuotation] = useState<LiveQuotation | null>(null);
  const [items, setItems] = useState<RFQItem[]>([]);
  const [quotes, setQuotes] = useState<Record<string, LineQuote>>({});
  const [leadTimeDays, setLeadTimeDays] = useState("");
  const [incoterms, setIncoterms] = useState("");
  const [paymentTerms, setPaymentTerms] = useState("");
  const [validUntil, setValidUntil] = useState("");
  const [freight, setFreight] = useState("");
  const [vendorNotes, setVendorNotes] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (id && portalData.contactId) fetchRFQDetail();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, portalData.contactId]);

  const fetchRFQDetail = async () => {
    if (!id || !portalData.contactId) return;
    setIsLoading(true);

    // `id` is the invitation id — the supplier's addressable handle on the RFQ.
    const { data: inv } = await db
      .from("rfq_invitations")
      .select("id, rfq_id, rfq_version, invitation_state, response_deadline")
      .eq("id", id)
      .maybeSingle();

    if (!inv) {
      setIsLoading(false);
      return;
    }
    setInvitation(inv as Invitation);

    const [rfqResult, itemsResult, quotationsResult] = await Promise.all([
      db.from("rfqs").select("id, rfq_number, status, deadline, notes, currency, version")
        .eq("id", inv.rfq_id).maybeSingle(),
      db.from("rfq_items").select("id, description, quantity, target_price, product_id")
        .eq("rfq_id", inv.rfq_id).order("sort_order"),
      db.from("rfq_quotations")
        .select("id, quotation_version, total, submitted_at, lead_time_days, incoterms, payment_terms, valid_until, notes, state, items:rfq_quotation_items(*)")
        .eq("invitation_id", inv.id)
        .order("quotation_version", { ascending: false }),
    ]);

    if (rfqResult.data) setRfq(rfqResult.data as RFQHeader);
    const rfqItems = (itemsResult.data ?? []) as RFQItem[];
    setItems(rfqItems);

    const live = (quotationsResult.data ?? []).find(
      (q: any) => q.state !== "withdrawn" && q.state !== "superseded",
    ) as LiveQuotation | undefined;
    setQuotation(live ?? null);

    // Seed the form from the previous version so re-quoting is an edit,
    // not a retype — the server still stores it as a new version.
    const seeded: Record<string, LineQuote> = {};
    for (const item of rfqItems) {
      const prior = (live?.items ?? []).find((li: any) => li.rfq_item_id === item.id);
      seeded[item.id] = {
        rfq_item_id: item.id,
        unit_price: prior?.unit_price ?? null,
        quoted_quantity: prior?.quoted_quantity ?? item.quantity,
        discount_percent: prior?.discount_percent ?? null,
        tax_rate: prior?.tax_rate ?? null,
        delivery_date: prior?.delivery_date ?? null,
        supplier_product_code: prior?.supplier_product_code ?? null,
        notes: prior?.notes ?? null,
        alternate_product: prior?.alternate_product_id
          ? {
              id: prior.alternate_product_id,
              name: prior.description ?? "Alternate product",
              sku: prior.supplier_product_code ?? null,
            }
          : null,
      };
    }
    setQuotes(seeded);
    setLeadTimeDays(live?.lead_time_days?.toString() ?? "");
    setIncoterms(live?.incoterms ?? "");
    setPaymentTerms(live?.payment_terms ?? "");
    setValidUntil(live?.valid_until ?? "");
    setVendorNotes(live?.notes ?? "");
    setIsLoading(false);
  };

  const updateQuote = (itemId: string, field: keyof LineQuote, value: string) => {
    setQuotes((prev) => ({
      ...prev,
      [itemId]: {
        ...prev[itemId],
        [field]: TEXT_LINE_FIELDS.has(field)
          ? value || null
          : value === ""
            ? null
            : Number(value),
      },
    }));
  };

  const setAlternate = (itemId: string, product: PortalProductOption | null) => {
    setQuotes((prev) => ({
      ...prev,
      [itemId]: { ...prev[itemId], alternate_product: product },
    }));
  };

  /** Indicative only — the authoritative total is recomputed by the RPC. */
  const calculateTotal = () =>
    items.reduce((sum, item) => {
      const q = quotes[item.id];
      if (q?.unit_price == null) return sum;
      const qty = q.quoted_quantity ?? item.quantity;
      const net = q.unit_price * qty * (1 - (q.discount_percent ?? 0) / 100);
      return sum + net + net * ((q.tax_rate ?? 0) / 100);
    }, 0) + (freight ? Number(freight) : 0);

  const handleSubmitQuote = async () => {
    if (!invitation) return;
    const lines = Object.values(quotes)
      .filter((q) => q.unit_price != null)
      .map((q) => ({
        rfq_item_id: q.rfq_item_id,
        unit_price: q.unit_price,
        quoted_quantity: q.quoted_quantity,
        discount_percent: q.discount_percent ?? 0,
        tax_rate: q.tax_rate ?? 0,
        delivery_date: q.delivery_date,
        supplier_product_code: q.supplier_product_code,
        notes: q.notes,
        is_alternate: !!q.alternate_product,
        alternate_product_id: q.alternate_product?.id ?? null,
        description: q.alternate_product?.name ?? null,
      }));

    if (lines.length === 0) {
      toast.error("Price at least one line before submitting");
      return;
    }

    setIsSubmitting(true);
    try {
      const { error } = await db.rpc("rfq_record_quotation", {
        _invitation_id: invitation.id,
        _header: {
          lead_time_days: leadTimeDays ? parseInt(leadTimeDays, 10) : null,
          incoterms: incoterms || null,
          payment_terms: paymentTerms || null,
          valid_until: validUntil || null,
          freight_amount: freight ? Number(freight) : 0,
          notes: vendorNotes || null,
        },
        _lines: lines,
        _allow_late: false,
      });
      if (error) throw error;

      toast.success(
        quotation ? "Revised quotation submitted" : "Quotation submitted successfully",
      );
      await fetchRFQDetail();
      refreshRFQs?.();
    } catch (err: any) {
      toast.error("Failed to submit quote: " + normalizeError(err).message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const effectiveDeadline = invitation?.response_deadline ?? rfq?.deadline ?? null;
  const isDeadlinePassed = effectiveDeadline ? new Date(effectiveDeadline) < new Date() : false;
  const isDeadlineSoon = effectiveDeadline
    ? new Date(effectiveDeadline).getTime() - Date.now() < 48 * 60 * 60 * 1000 && !isDeadlinePassed
    : false;
  const isStale = !!invitation && !!rfq && invitation.rfq_version !== rfq.version;
  const canSubmit =
    !isDeadlinePassed &&
    !isStale &&
    !!rfq &&
    ["sent", "responses_received", "under_evaluation"].includes(rfq.status);
  const currency = rfq?.currency ?? "";

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!rfq || !invitation) {
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

      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-foreground">
            {rfq.rfq_number}
            {rfq.version > 1 && (
              <span className="ml-2 text-base font-normal text-muted-foreground">
                rev {rfq.version}
              </span>
            )}
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            Request for Quotation from {portalData.organizationName || "Organization"}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Badge variant="secondary">{rfq.status.replace(/_/g, " ")}</Badge>
          <Badge variant={invitation.invitation_state === "responded" ? "default" : "destructive"}>
            {invitation.invitation_state.replace(/_/g, " ")}
          </Badge>
          {quotation && <Badge variant="outline">Quote v{quotation.quotation_version}</Badge>}
        </div>
      </div>

      {isStale && (
        <Card className="border-orange-300 dark:border-orange-700">
          <CardContent className="pt-4 pb-4 flex items-center gap-2 text-orange-600">
            <AlertTriangle className="h-5 w-5" />
            <span className="font-medium">
              This RFQ has been revised. Wait for the buyer to re-issue your invitation before quoting.
            </span>
          </CardContent>
        </Card>
      )}

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
              Deadline approaching: {new Date(effectiveDeadline!).toLocaleString()}
            </span>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Card>
          <CardContent className="pt-4 pb-4">
            <p className="text-sm text-muted-foreground">Response deadline</p>
            <p className="font-medium">
              {effectiveDeadline ? new Date(effectiveDeadline).toLocaleString() : "No deadline"}
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

      {quotation && (
        <Card className="border-green-200 dark:border-green-800">
          <CardContent className="pt-4 pb-4 flex items-center gap-2 text-green-600">
            <CheckCircle className="h-5 w-5" />
            <span className="font-medium">
              Quotation v{quotation.quotation_version} submitted{" "}
              {new Date(quotation.submitted_at).toLocaleString()} — total {currency}{" "}
              {quotation.total.toFixed(2)}. Submitting again creates a new version.
            </span>
          </CardContent>
        </Card>
      )}

      {/*
        Bid attachments hang off a quotation version, so they only become
        available once the supplier has submitted a bid. Revising the bid
        carries the documents forward server-side.
      */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Supporting documents</CardTitle>
        </CardHeader>
        <CardContent>
          {quotation ? (
            <BidAttachmentsPanel
              rfqId={rfq.id}
              quotationId={quotation.id}
              canEdit={canSubmit}
              emptyLabel={
                canSubmit
                  ? "Attach technical specs, certificates or a signed price list to your bid."
                  : "No supporting documents attached."
              }
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              Submit your quote first — supporting documents attach to a bid version.
            </p>
          )}
        </CardContent>
      </Card>



      <Card>
        <CardHeader>
          <CardTitle className="text-base">Your pricing</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Item</TableHead>
                  <TableHead className="text-right">Requested</TableHead>
                  <TableHead className="w-[140px]">Your item code</TableHead>
                  <TableHead className="w-[220px]">Alternate offered</TableHead>
                  <TableHead className="w-[120px]">Unit price</TableHead>
                  <TableHead className="w-[110px]">Qty offered</TableHead>
                  <TableHead className="w-[90px]">Disc %</TableHead>
                  <TableHead className="w-[90px]">Tax %</TableHead>
                  <TableHead className="w-[150px]">Delivery</TableHead>
                  <TableHead className="w-[180px]">Line note</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell className="font-medium">{item.description}</TableCell>
                    <TableCell className="text-right tabular-nums">{item.quantity}</TableCell>
                    <TableCell>
                      <Input
                        disabled={!canSubmit}
                        placeholder="SKU / ref"
                        value={quotes[item.id]?.supplier_product_code ?? ""}
                        onChange={(e) =>
                          updateQuote(item.id, "supplier_product_code", e.target.value)
                        }
                      />
                    </TableCell>
                    <TableCell>
                      <AlternateProductPicker
                        invitationId={invitation.id}
                        disabled={!canSubmit}
                        value={quotes[item.id]?.alternate_product ?? null}
                        onChange={(product) => setAlternate(item.id, product)}
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        type="number"
                        min="0"
                        step="0.01"
                        disabled={!canSubmit}
                        value={quotes[item.id]?.unit_price ?? ""}
                        onChange={(e) => updateQuote(item.id, "unit_price", e.target.value)}
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        type="number"
                        min="0"
                        disabled={!canSubmit}
                        value={quotes[item.id]?.quoted_quantity ?? ""}
                        onChange={(e) => updateQuote(item.id, "quoted_quantity", e.target.value)}
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        type="number"
                        min="0"
                        max="100"
                        step="0.01"
                        disabled={!canSubmit}
                        value={quotes[item.id]?.discount_percent ?? ""}
                        onChange={(e) => updateQuote(item.id, "discount_percent", e.target.value)}
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        type="number"
                        min="0"
                        step="0.01"
                        disabled={!canSubmit}
                        value={quotes[item.id]?.tax_rate ?? ""}
                        onChange={(e) => updateQuote(item.id, "tax_rate", e.target.value)}
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        type="date"
                        disabled={!canSubmit}
                        value={quotes[item.id]?.delivery_date ?? ""}
                        onChange={(e) => updateQuote(item.id, "delivery_date", e.target.value)}
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        disabled={!canSubmit}
                        placeholder="Substitute / remark"
                        value={quotes[item.id]?.notes ?? ""}
                        onChange={(e) => updateQuote(item.id, "notes", e.target.value)}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <Separator />

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label>Lead time (days)</Label>
              <Input
                type="number"
                min="0"
                disabled={!canSubmit}
                value={leadTimeDays}
                onChange={(e) => setLeadTimeDays(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>Incoterms</Label>
              <Input
                disabled={!canSubmit}
                placeholder="e.g. DDP"
                value={incoterms}
                onChange={(e) => setIncoterms(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>Payment terms</Label>
              <Input
                disabled={!canSubmit}
                placeholder="e.g. Net 30"
                value={paymentTerms}
                onChange={(e) => setPaymentTerms(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>Quote valid until</Label>
              <Input
                type="date"
                disabled={!canSubmit}
                value={validUntil}
                onChange={(e) => setValidUntil(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>Freight / other charges</Label>
              <Input
                type="number"
                min="0"
                step="0.01"
                disabled={!canSubmit}
                value={freight}
                onChange={(e) => setFreight(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label>Notes to buyer</Label>
            <Textarea
              rows={3}
              disabled={!canSubmit}
              value={vendorNotes}
              onChange={(e) => setVendorNotes(e.target.value)}
            />
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              Indicative total:{" "}
              <span className="font-semibold text-foreground tabular-nums">
                {currency} {calculateTotal().toFixed(2)}
              </span>
            </p>
            <Button onClick={handleSubmitQuote} disabled={!canSubmit || isSubmitting}>
              {isSubmitting ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Send className="h-4 w-4 mr-2" />
              )}
              {quotation ? "Submit revised quote" : "Submit quote"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
