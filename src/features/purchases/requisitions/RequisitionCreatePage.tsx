/**
 * RequisitionCreatePage — P3 Requisitions Workbench.
 *
 * Thin form over `create_purchase_requisition` RPC. The RPC allocates
 * a PR number (PR-YYYY-XXXX) and inserts lines atomically. Draft
 * requisitions do not consume any budget or emit lifecycle events
 * until submitted.
 *
 * Currency is derived, never typed: a requisition estimates spend in the
 * money the business keeps its books in. Foreign-currency exposure is
 * created by the supplier, which is unknown at requisition time, so it
 * shows up on the quotation and the purchase order instead.
 */
import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";

import { PageBody, PageHeader, ActionBar, Section } from "@/design-system";
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
import { EditableLineItemsGrid } from "@/design-system/records/EditableLineItemsGrid";
import {
  RequisitionLineRow,
  REQUISITION_LINE_COLUMNS,
} from "@/components/documents/lines/RequisitionLineRow";
import { useToast } from "@/hooks/use-toast";
import { useBusinesses } from "@/contexts/BusinessContext";
import { useSuppliers } from "../suppliers/useSuppliers";
import { useProducts } from "@/hooks/useProducts";
import { useAnalyticAccounts } from "@/hooks/useAnalyticAccounts";
import { useWarehouses } from "@/hooks/useWarehouses";
import {
  createPurchaseRequisition,
  type RequisitionLineInput,
} from "./requisitionRpcs";
import {
  resolvePurchaseLineDefaults,
  summarisePurchaseLineRefusals,
  validatePurchaseLinesAgainstTerms,
} from "@/features/purchases/purchasingTerms/purchaseLineTerms";

const PRIORITIES = ["low", "normal", "high", "urgent"] as const;

export default function RequisitionCreatePage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { currentBusiness } = useBusinesses();
  const { rows: suppliers, loading: suppliersLoading } = useSuppliers();
  const { products } = useProducts();
  const { accounts: analyticAccounts } = useAnalyticAccounts();
  const { warehouses } = useWarehouses();

  const [needByDate, setNeedByDate] = useState<string>("");
  const [priority, setPriority] = useState<(typeof PRIORITIES)[number]>("normal");
  const [analyticAccountId, setAnalyticAccountId] = useState<string>("none");
  const [destinationWarehouseId, setDestinationWarehouseId] = useState<string>("none");
  const [justification, setJustification] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<RequisitionLineInput[]>([
    { product_id: null, description: "", quantity: 1, estimated_unit_price: 0 },
  ]);

  const currency = currentBusiness?.base_currency ?? "—";
  const [busy, setBusy] = useState(false);

  const addLine = useCallback(
    () =>
      setLines((ls) => [
        ...ls,
        { product_id: null, description: "", quantity: 1, estimated_unit_price: 0 },
      ]),
    [],
  );

  const updateLine = useCallback(
    (idx: number, patch: Partial<RequisitionLineInput>) => {
      setLines((ls) => ls.map((l, i) => (i === idx ? { ...l, ...patch } : l)));

      // Picking a product (or naming a supplier) seeds the line from supplier
      // purchasing terms — MOQ and purchase unit, resolved server-side.
      const productId = patch.product_id;
      if (!productId || !currentBusiness) return;
      void (async () => {
        try {
          const defaults = await resolvePurchaseLineDefaults({
            businessId: currentBusiness.id,
            productId,
            supplierId: patch.suggested_supplier_id ?? null,
            onDate: needByDate || null,
          });
          if (!defaults) return;
          setLines((ls) =>
            ls.map((l, i) =>
              i === idx
                ? {
                    ...l,
                    quantity: defaults.quantity,
                    display_uom_id: defaults.displayUomId,
                    ...(defaults.unitPrice != null
                      ? { estimated_unit_price: defaults.unitPrice }
                      : {}),
                  }
                : l,
            ),
          );
        } catch {
          // Advisory at entry time; submit re-validates against the server.
        }
      })();
    },
    [currentBusiness, needByDate],
  );

  const removeLine = useCallback(
    (idx: number) => setLines((ls) => ls.filter((_, i) => i !== idx)),
    [],
  );

  const productOptions = useMemo(
    () =>
      products
        .filter((p) => p.is_active !== false)
        .map((p) => ({ id: p.id, name: p.name, sku: p.sku, unit_price: p.unit_price })),
    [products],
  );

  const costCentreOptions = useMemo(
    () =>
      (analyticAccounts ?? []).filter(
        (a: any) => a.is_active !== false && (a.analytic_type === "cost_center" || a.analytic_type === "department"),
      ),
    [analyticAccounts],
  );

  const supplierOptions = useMemo(
    () =>
      suppliers.map((s) => ({
        id: s.id,
        label: s.contact?.name ?? s.supplier_code ?? s.id,
      })),
    [suppliers],
  );

  const estimatedTotal = lines.reduce(
    (t, l) => t + (Number(l.quantity) || 0) * (Number(l.estimated_unit_price) || 0),
    0,
  );

  async function handleSubmit() {
    if (!currentBusiness) return;
    const cleanLines = lines
      .map((l) => ({ ...l, description: (l.description || "").trim() }))
      .filter((l) => l.description.length > 0 && Number(l.quantity) > 0);
    if (cleanLines.length === 0) {
      toast({
        title: "Add at least one line",
        description: "Each line needs a description and a quantity greater than zero.",
        variant: "destructive",
      });
      return;
    }
    setBusy(true);
    try {
      const refusals = await validatePurchaseLinesAgainstTerms({
        businessId: currentBusiness.id,
        onDate: needByDate || null,
        lines: cleanLines.map((l, index) => ({
          index,
          productId: l.product_id,
          supplierId: l.suggested_supplier_id ?? null,
          quantity: Number(l.quantity),
          productName: l.description,
        })),
      });
      if (refusals.length > 0) {
        toast({
          title: "Supplier purchasing terms",
          description: summarisePurchaseLineRefusals(refusals),
          variant: "destructive",
        });
        setBusy(false);
        return;
      }
      const id = await createPurchaseRequisition({
        businessId: currentBusiness.id,
        needByDate: needByDate || null,
        priority,
        analyticAccountId: analyticAccountId === "none" ? null : analyticAccountId,
        destinationWarehouseId:
          destinationWarehouseId === "none" ? null : destinationWarehouseId,
        costCenter:
          costCentreOptions.find((a: any) => a.id === analyticAccountId)?.code ?? null,
        justification: justification || null,
        notes: notes || null,
        lines: cleanLines,
      });
      toast({ title: "Requisition drafted" });
      navigate(`/purchases/requisitions/${id}`);
    } catch (e: any) {
      toast({
        title: "Create failed",
        description: e?.message ?? String(e),
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="Purchases"
        title="New requisition"
        description="Draft an internal purchase request. It stays in Draft until you submit it for approval."
        actions={
          <ActionBar>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => navigate("/purchases/requisitions")}
            >
              <ArrowLeft className="mr-2 h-4 w-4" /> Back
            </Button>
            <Button size="sm" onClick={handleSubmit} disabled={busy}>
              Create draft
            </Button>
          </ActionBar>
        }
      />
      <PageBody>
        <Section title="Header">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <Label>Need by</Label>
              <Input
                type="date"
                value={needByDate}
                onChange={(e) => setNeedByDate(e.target.value)}
              />
            </div>
            <div>
              <Label>Priority</Label>
              <Select value={priority} onValueChange={(v) => setPriority(v as any)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PRIORITIES.map((p) => (
                    <SelectItem key={p} value={p} className="capitalize">
                      {p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Currency</Label>
              <Input value={currency} readOnly disabled />
              <p className="mt-1 text-xs text-muted-foreground">
                Company base currency. Supplier currency is decided on the quotation or PO.
              </p>
            </div>
            <div>
              <Label>Cost centre</Label>
              <Select value={analyticAccountId} onValueChange={setAnalyticAccountId}>
                <SelectTrigger>
                  <SelectValue placeholder="None" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  {costCentreOptions.map((a: any) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.code ? `${a.code} · ${a.name}` : a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Deliver to</Label>
              <Select value={destinationWarehouseId} onValueChange={setDestinationWarehouseId}>
                <SelectTrigger>
                  <SelectValue placeholder="No specific location" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No specific location</SelectItem>
                  {(warehouses ?? []).map((w: any) => (
                    <SelectItem key={w.id} value={w.id}>
                      {w.code ? `${w.code} · ${w.name}` : w.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="md:col-span-2">
              <Label>Justification</Label>
              <Input
                value={justification}
                onChange={(e) => setJustification(e.target.value)}
                placeholder="Why is this needed?"
              />
            </div>
          </div>
        </Section>

        <Section
          title="Lines"
          description="Items or services being requested. Approvers see the estimated total."
        >
          <EditableLineItemsGrid
            columns={REQUISITION_LINE_COLUMNS}
            rows={lines}
            onAddRow={addLine}
            onRemoveRow={removeLine}
            addLabel="Add line"
            disabled={busy}
            renderRow={(line, i, layout) => (
              <RequisitionLineRow
                key={i}
                index={i}
                item={line}
                products={productOptions}
                suppliers={supplierOptions}
                suppliersLoading={suppliersLoading}
                layout={layout}
                disabled={busy}
                onPatch={updateLine}
              />
            )}
            footer={
              <div className="text-right text-sm">
                Estimated total:{" "}
                <span className="font-semibold">
                  {currency} {estimatedTotal.toFixed(2)}
                </span>
              </div>
            }
          />
        </Section>

        <Section title="Notes">
          <Textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Any additional context for approvers or buyers…"
            rows={4}
          />
        </Section>
      </PageBody>
    </>
  );
}
