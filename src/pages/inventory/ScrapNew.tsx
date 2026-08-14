/**
 * Scrap / Waste record — create surface.
 *
 * Delegates through `useRecordScrap`, the canonical scrap lifecycle hook.
 * The backend creates a `stock_adjustments` document, posts inventory and
 * GL atomically, and enforces governance controls server-side.
 */
import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranches } from "@/hooks/useBranches";
import { useProducts } from "@/hooks/useProducts";
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
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Info, ShieldAlert } from "lucide-react";
import {
  RecordFormShell,
  Section,
  FieldGrid,
  FieldCell,
} from "@/design-system";
import { SCRAP_REASONS } from "./scrapReasons";
import { useRecordScrap, useScrapReasons } from "@/hooks/useScrap";

export default function ScrapNew() {
  const navigate = useNavigate();
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranches();
  const { products } = useProducts();
  const recordScrap = useRecordScrap();

  const inventoryProducts = products.filter((p) => p.type === "product");

  const [warehouses, setWarehouses] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    if (!currentOrg?.id || !currentBusiness?.id) return;
    let q = supabase
      .from("warehouses")
      .select("id, name")
      .eq("organization_id", currentOrg.id)
      .eq("is_active", true)
      // In-transit buckets are bookkeeping, never a scrap source.
      .or("is_in_transit.is.null,is_in_transit.eq.false")
      .eq("business_id", currentBusiness.id);

    if (currentBranch?.id) q = q.eq("branch_id", currentBranch.id);
    q.then(({ data }: any) => setWarehouses(data || []));
  }, [currentOrg?.id, currentBusiness?.id, currentBranch?.id]);

  const [form, setForm] = useState({
    product_id: "",
    warehouse_id: "",
    quantity: 1,
    unit_cost: 0,
    reason: "",
    notes: "",
  });
  const [isSubmitting, setIsSubmitting] = useState(false);

  const { data: dbReasons = [] } = useScrapReasons();
  const reasonList = dbReasons.length
    ? dbReasons.map((r) => ({
        code: r.code,
        label: r.label,
        description: r.description ?? "",
        requiresAttachment: r.requires_attachment,
        insuranceEligible: r.insurance_claim_flag,
      }))
    : SCRAP_REASONS;

  const selectedProduct = inventoryProducts.find((p) => p.id === form.product_id);
  const selectedReason = reasonList.find((r) => r.code === form.reason);
  const productCost = (selectedProduct as any)?.cost_price ?? 0;

  // When the product changes, seed unit cost from product.cost_price so the
  // caller can see (and override) what will be booked to the GL.
  useEffect(() => {
    if (selectedProduct) {
      setForm((f) => ({ ...f, unit_cost: Number(productCost) || 0 }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.product_id]);

  useEffect(() => {
    setForm((f) => {
      if (!f.warehouse_id) return f;
      return warehouses.some((w) => w.id === f.warehouse_id)
        ? f
        : { ...f, warehouse_id: "" };
    });
  }, [warehouses]);

  const totalValue = Math.abs(form.quantity || 0) * Number(form.unit_cost || 0);
  const invalid =
    !currentBusiness?.id || !form.product_id || !form.warehouse_id || !form.reason || form.quantity <= 0;

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!currentOrg?.id || invalid) return;
    setIsSubmitting(true);
    try {
      await recordScrap.mutateAsync({
        product_id: form.product_id,
        warehouse_id: form.warehouse_id || null,
        quantity: form.quantity,
        unit_cost: Number(form.unit_cost) || 0,
        reason: form.reason,
        notes: form.notes || null,
      });
      navigate("/inventory-app/scrap");
    } catch {
      // useRecordScrap owns user-facing error toasts.
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <RecordFormShell
      mode="create"
      entityLabel="Scrap Record"
      cancelHref="/inventory-app/scrap"
      onSubmit={handleSubmit}
      isSubmitting={isSubmitting}
      submitDisabled={invalid}
      submitLabel="Record Scrap"
    >
      <Section title="Item" description="What was scrapped and from where.">
        <FieldGrid columns={2}>
          <FieldCell span={2}>
            <div className="space-y-2">
              <Label>Product *</Label>
              <Select
                value={form.product_id}
                onValueChange={(v) => setForm((f) => ({ ...f, product_id: v }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select product" />
                </SelectTrigger>
                <SelectContent>
                  {inventoryProducts.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </FieldCell>
          <div className="space-y-2">
            <Label>Warehouse *</Label>
            <Select
              value={form.warehouse_id}
              onValueChange={(v) => setForm((f) => ({ ...f, warehouse_id: v }))}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select warehouse" />
              </SelectTrigger>
              <SelectContent>
                {warehouses.map((w) => (
                  <SelectItem key={w.id} value={w.id}>
                    {w.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Quantity *</Label>
            <Input
              type="number"
              min={1}
              step="any"
              value={form.quantity}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  quantity: parseFloat(e.target.value) || 0,
                }))
              }
            />
          </div>
          <div className="space-y-2">
            <Label>Unit cost</Label>
            <Input
              type="number"
              min={0}
              step="any"
              value={form.unit_cost}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  unit_cost: parseFloat(e.target.value) || 0,
                }))
              }
            />
            <p className="text-xs text-muted-foreground">
              Server resolves this against warehouse average / product cost /
              last inbound if left at 0.
            </p>
          </div>
          <div className="space-y-2">
            <Label>Total loss value</Label>
            <div className="rounded-md border bg-muted/40 px-3 py-2 font-medium">
              {totalValue.toLocaleString(undefined, {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}
            </div>
          </div>
        </FieldGrid>
      </Section>

      <Section title="Reason" description="Drives GL account mapping, approvals, and downstream saga handlers.">
        <FieldGrid columns={2}>
          <div className="space-y-2">
            <Label>Reason *</Label>
            <Select
              value={form.reason}
              onValueChange={(v) => setForm((f) => ({ ...f, reason: v }))}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select reason" />
              </SelectTrigger>
              <SelectContent>
                {reasonList.map((r) => (
                  <SelectItem key={r.code} value={r.code}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selectedReason && (
              <p className="text-xs text-muted-foreground">{selectedReason.description}</p>
            )}
          </div>
          <div className="space-y-2">
            <Label>Additional notes</Label>
            <Textarea
              value={form.notes}
              onChange={(e) =>
                setForm((f) => ({ ...f, notes: e.target.value }))
              }
              placeholder="Optional details..."
            />
          </div>

          {selectedReason?.requiresAttachment && (
            <FieldCell span={2}>
              <Alert>
                <Info className="h-4 w-4" />
                <AlertDescription>
                  This reason typically requires a supporting document
                  (disposal certificate, expiry log, or photo). Attachment
                  upload will be enforced once the scrap-attachments feature
                  ships; for now, reference the document in notes.
                </AlertDescription>
              </Alert>
            </FieldCell>
          )}
          {selectedReason?.insuranceEligible && (
            <FieldCell span={2}>
              <Alert>
                <ShieldAlert className="h-4 w-4" />
                <AlertDescription>
                  Theft / shrinkage may be eligible for an insurance claim.
                  A domain event will fire on post so the claims workflow
                  can pick it up.
                </AlertDescription>
              </Alert>
            </FieldCell>
          )}

          <FieldCell span={2}>
            <Alert>
              <Info className="h-4 w-4" />
              <AlertDescription>
                Segregation of duties: whoever creates a scrap cannot also
                approve it. Owners may issue a one-time co-signed override.
                The offset expense posts to the inventory-shrinkage account
                resolved by the finance engine.
              </AlertDescription>
            </Alert>
          </FieldCell>
        </FieldGrid>
      </Section>
    </RecordFormShell>
  );
}
