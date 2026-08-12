/**
 * LotDetail — full lot genealogy for a single `stock_lots` row.
 *
 * Phase G · Inventory Foundation Audit. Read-only view composed of
 * three sections, all derived from existing tables scoped by
 * business + product + lot_number:
 *
 *   1. Origin — lot header + GRN + supplier.
 *   2. On-hand distribution — per-warehouse net (in − out) from
 *      `stock_movements`.
 *   3. Timeline — every `stock_movements` row in chronological order,
 *      resolving `reference_type` to a human label + best-effort link.
 *
 * ADR 0070. No writes. No RPCs. No schema changes.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
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
import { ArrowLeft, Loader2, Boxes, ArrowDownRight, ArrowUpRight, AlertOctagon } from "lucide-react";
import { format } from "date-fns";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { usePermissions } from "@/hooks/usePermissions";
import { PrintLabelButton } from "@/components/labels/PrintLabelButton";

interface LotHeader {
  id: string;
  business_id: string;
  organization_id: string;
  product_id: string;
  lot_number: string;
  serial_number: string | null;
  expiry_date: string | null;
  manufacture_date: string | null;
  is_active: boolean;
  goods_receipt_id: string | null;
  notes: string | null;
  created_at: string;
  product?: { id: string; name: string; sku: string | null } | null;
  supplier?: { id: string; name: string } | null;
  goods_receipt?: { id: string; receipt_number: string | null } | null;
}

interface MovementRow {
  id: string;
  movement_date: string;
  movement_type: string;
  quantity: number;
  warehouse_id: string;
  reference_type: string | null;
  reference_id: string | null;
  notes: string | null;
  serial_number: string | null;
  warehouse?: { id: string; name: string } | null;
}

const REFERENCE_LABELS: Record<string, string> = {
  goods_receipt: "Goods Receipt",
  invoice: "Invoice",
  credit_note: "Credit Note",
  sales_return: "Sales Return",
  delivery_note: "Delivery Note",
  stock_transfer: "Stock Transfer",
  stock_adjustment: "Stock Adjustment",
  scrap: "Scrap",
  pos_register: "POS Sale",
  purchase_return: "Purchase Return",
  physical_count: "Physical Count",
};

// Movement types that ADD stock (positive quantity flow).
const INBOUND_TYPES = new Set([
  "receipt",
  "goods_receipt",
  "purchase",
  "sales_return",
  "transfer_in",
  "adjustment_in",
  "opening_balance",
]);

function isInbound(mt: string) {
  return INBOUND_TYPES.has(mt);
}

/**
 * supabase-js parses every select string literal at the type level. These two
 * queries each pull several nested relations, which tips `tsc` into TS2589
 * ("type instantiation is excessively deep"). Widening the argument to plain
 * `string` skips that parsing; the row shapes are pinned by the explicit
 * `LotHeader` / `MovementRow` casts below.
 */
const sel = (s: string): string => s;


export default function LotDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { can } = usePermissions();
  const [lot, setLot] = useState<LotHeader | null>(null);
  const [movements, setMovements] = useState<MovementRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [recallOpen, setRecallOpen] = useState(false);
  const [recallReason, setRecallReason] = useState("");
  const [recalling, setRecalling] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    const { data: lotRow, error: lotErr } = await supabase
      .from("stock_lots")
      .select(
        "id, business_id, organization_id, product_id, lot_number, serial_number, expiry_date, manufacture_date, is_active, goods_receipt_id, notes, created_at, product:products(id, name, sku), supplier:contacts(id, name), goods_receipt:goods_receipts(id, receipt_number)",
      )
      .eq("id", id)
      .maybeSingle();
    if (lotErr || !lotRow) {
      if (lotErr) toast({ title: "Failed to load lot", description: lotErr.message, variant: "destructive" });
      setLot(null);
      setMovements([]);
      setLoading(false);
      return;
    }
    const header = lotRow as unknown as LotHeader;
    setLot(header);

    // Timeline: business + product + lot_number is the canonical
    // traceability query. Never drop any of the three predicates.
    const { data: mvRows, error: mvErr } = await supabase
      .from("stock_movements")
      .select(
        "id, movement_date, movement_type, quantity, warehouse_id, reference_type, reference_id, notes, serial_number, warehouse:warehouses(id, name)",
      )
      .eq("business_id", header.business_id)
      .eq("product_id", header.product_id)
      .eq("lot_number", header.lot_number)
      .order("movement_date", { ascending: true });
    if (mvErr) {
      toast({ title: "Failed to load movements", description: mvErr.message, variant: "destructive" });
      setMovements([]);
    } else {
      setMovements((mvRows ?? []) as unknown as MovementRow[]);
    }
    setLoading(false);
  }, [id, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const distribution = useMemo(() => {
    const bucket = new Map<string, { warehouse: string; net: number }>();
    for (const m of movements) {
      const key = m.warehouse_id;
      const name = m.warehouse?.name ?? "—";
      const cur = bucket.get(key) ?? { warehouse: name, net: 0 };
      cur.net += isInbound(m.movement_type) ? m.quantity : -m.quantity;
      bucket.set(key, cur);
    }
    return Array.from(bucket.entries()).map(([id, v]) => ({ id, ...v }));
  }, [movements]);

  const totalOnHand = distribution.reduce((s, d) => s + d.net, 0);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!lot) {
    return (
      <div className="py-16 text-center text-muted-foreground">
        <p>Lot not found.</p>
        <Button variant="outline" className="mt-4" onClick={() => navigate("/inventory-app/lots")}>
          Back to lots
        </Button>
      </div>
    );
  }

  const canRecall = can("manageProducts");

  const handleRecall = async () => {
    if (!lot) return;
    if (!recallReason.trim()) {
      toast({ title: "Reason required", description: "Please describe the recall reason.", variant: "destructive" });
      return;
    }
    setRecalling(true);
    try {
      const { data, error } = await supabase.rpc("recall_lot" as any, {
        p_business_id: lot.business_id,
        p_product_id: lot.product_id,
        p_lot_number: lot.lot_number,
        p_reason: recallReason.trim(),
      } as any);
      if (error) throw error;
      const res = data as any;
      const custCount = Array.isArray(res?.downstream_customers)
        ? res.downstream_customers.length
        : 0;
      toast({
        title: `Recall opened · ${res?.recall_reference ?? ""}`,
        description: `Quarantined ${Number(res?.quarantined_units || 0).toLocaleString()} units across ${res?.warehouses_affected || 0} warehouse(s). ${custCount} downstream customer(s) identified.`,
      });
      setRecallOpen(false);
      setRecallReason("");
      await load();
    } catch (e: any) {
      toast({ title: "Recall failed", description: e?.message ?? String(e), variant: "destructive" });
    } finally {
      setRecalling(false);
    }
  };

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="page-header">
        <div className="flex items-start gap-3 justify-between w-full">
          <div className="flex items-start gap-3">
            <Button variant="ghost" size="icon" onClick={() => navigate("/inventory-app/lots")}>
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <div>
              <div className="flex items-center gap-2">
                <Boxes className="h-5 w-5 text-muted-foreground" />
                <h1 className="page-title font-mono">{lot.lot_number}</h1>
                {lot.is_active ? <Badge variant="secondary">Active</Badge> : <Badge variant="outline">Inactive</Badge>}
              </div>
              <p className="text-sm text-muted-foreground mt-1">
                {lot.product?.name ?? "—"}
                {lot.product?.sku ? <span className="font-mono"> · {lot.product.sku}</span> : null}
              </p>
            </div>
          </div>
          {canRecall && lot.is_active && (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setRecallOpen(true)}
              className="shrink-0"
            >
              <AlertOctagon className="h-4 w-4 mr-1.5" />
              Recall this lot
            </Button>
          )}
          <PrintLabelButton
            label="Print lot label"
            templateKey="lot_label"
            workflow="product_tag"
            product={{
              id: lot.product?.id ?? null,
              name: lot.product?.name ?? null,
              sku: lot.product?.sku ?? null,
              barcode: null,
            }}
            lotNumber={lot.lot_number}
            expiryDate={lot.expiry_date ?? null}
            manufactureDate={lot.manufacture_date ?? null}
            sourceDocType="stock_lot"
            sourceDocId={lot.id}
            idempotencyKey={`lot_label:${lot.id}`}
            extraVars={{ lot_number: lot.lot_number }}
            className="shrink-0"
          />
        </div>
      </div>

      <AlertDialog open={recallOpen} onOpenChange={setRecallOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Recall lot {lot.lot_number}?</AlertDialogTitle>
            <AlertDialogDescription>
              This quarantines all remaining on-hand for this batch across every
              warehouse and opens a Product Recall record. The action is
              recorded and downstream customers who received this lot will be
              enumerated for follow-up.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2">
            <Label htmlFor="recall-reason">Reason</Label>
            <Textarea
              id="recall-reason"
              value={recallReason}
              onChange={(e) => setRecallReason(e.target.value)}
              placeholder="e.g. Contamination detected in batch — pull from all shelves"
              rows={3}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={recalling}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void handleRecall();
              }}
              disabled={recalling || !recallReason.trim()}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {recalling ? "Recalling…" : "Confirm recall"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>


      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Origin</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <div className="text-xs text-muted-foreground">Supplier</div>
              <div>{lot.supplier?.name ?? "—"}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Goods Receipt</div>
              <div className="font-mono text-xs">
                {lot.goods_receipt?.receipt_number ?? (lot.goods_receipt_id ? lot.goods_receipt_id.slice(0, 8) : "—")}
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Manufactured</div>
              <div>{lot.manufacture_date ? format(new Date(lot.manufacture_date), "dd MMM yyyy") : "—"}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Expires</div>
              <div>{lot.expiry_date ? format(new Date(lot.expiry_date), "dd MMM yyyy") : "—"}</div>
            </div>
            <div className="col-span-2">
              <div className="text-xs text-muted-foreground">First received</div>
              <div>{format(new Date(lot.created_at), "dd MMM yyyy HH:mm")}</div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">On-hand distribution</CardTitle>
          </CardHeader>
          <CardContent>
            {distribution.length === 0 ? (
              <div className="text-sm text-muted-foreground py-6 text-center">No movements yet.</div>
            ) : (
              <div className="space-y-2">
                {distribution.map((d) => (
                  <div key={d.id} className="flex items-center justify-between text-sm border-b last:border-b-0 pb-2 last:pb-0">
                    <span>{d.warehouse}</span>
                    <span className={`font-mono ${d.net > 0 ? "text-foreground" : d.net < 0 ? "text-destructive" : "text-muted-foreground"}`}>
                      {d.net.toLocaleString()}
                    </span>
                  </div>
                ))}
                <div className="flex items-center justify-between text-sm pt-2 border-t font-medium">
                  <span>Total on-hand</span>
                  <span className="font-mono">{totalOnHand.toLocaleString()}</span>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Movement timeline ({movements.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {movements.length === 0 ? (
            <div className="text-sm text-muted-foreground py-6 text-center">No movements recorded for this lot.</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Reference</TableHead>
                  <TableHead>Warehouse</TableHead>
                  <TableHead>Serial</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {movements.map((m) => {
                  const inbound = isInbound(m.movement_type);
                  const refLabel = m.reference_type
                    ? REFERENCE_LABELS[m.reference_type] ?? m.reference_type
                    : "—";
                  return (
                    <TableRow key={m.id}>
                      <TableCell className="text-xs whitespace-nowrap">
                        {format(new Date(m.movement_date), "dd MMM yyyy HH:mm")}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1.5 text-xs">
                          {inbound ? (
                            <ArrowDownRight className="h-3.5 w-3.5 text-green-600" />
                          ) : (
                            <ArrowUpRight className="h-3.5 w-3.5 text-orange-600" />
                          )}
                          <span className="capitalize">{m.movement_type.replace(/_/g, " ")}</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-xs">
                        <div>{refLabel}</div>
                        {m.reference_id && (
                          <div className="font-mono text-[10px] text-muted-foreground">{m.reference_id.slice(0, 8)}</div>
                        )}
                      </TableCell>
                      <TableCell className="text-xs">{m.warehouse?.name ?? "—"}</TableCell>
                      <TableCell className="font-mono text-xs">{m.serial_number ?? "—"}</TableCell>
                      <TableCell className={`text-right font-mono ${inbound ? "" : "text-orange-700"}`}>
                        {inbound ? "+" : "−"}{m.quantity.toLocaleString()}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
