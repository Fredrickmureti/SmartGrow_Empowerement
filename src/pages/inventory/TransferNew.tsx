/**
 * Stock Transfer — routed create surface.
 *
 * Reuses `useWarehouses().createStockTransfer` and the barcode scanner UX
 * that used to live in the New Transfer dialog. Deep-link prefill via
 * `?product=<id>` is preserved (previously `?action=new&product=<id>` on
 * the list page).
 */
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useWarehouses } from "@/hooks/useWarehouses";
import { useProducts } from "@/hooks/useProducts";
import { useBranches } from "@/hooks/useBranches";
import { useBusinesses } from "@/hooks/useBusinesses";
import { BarcodeInputField } from "@/components/scanner/BarcodeInputField";
import { useResolveProductIdentity } from "@/hooks/inventory/useResolveProductIdentity";
import { identityOutcomeLine } from "@/features/products/identity/identityOutcome";
import { ScannerPairingButton } from "@/components/scanner/ScannerPairingButton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  RecordFormShell,
  Section,
  FieldGrid,
} from "@/design-system";

type Item = { product_id: string; quantity_requested: number };

export default function TransferNew() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { warehouses, createStockTransfer } = useWarehouses();
  const { products } = useProducts();
  const { currentBranch } = useBranches();
  const { currentBusiness } = useBusinesses();
  // Phase C3 — a case/inner barcode adds its full base-unit content.
  const { resolve: resolveIdentity } = useResolveProductIdentity(
    currentBusiness?.id,
    currentBranch?.id ?? null,
    // Typing path: transfers can be keyed by SKU as well as scanned.
    { allowSkuFallback: true },
  );

  const inventoryProducts = useMemo(
    () => products.filter((p: any) => p.type === "product" && (p.status ?? "active") === "active"),
    [products],
  );

  const [fromWarehouseId, setFromWarehouseId] = useState("");
  const [toWarehouseId, setToWarehouseId] = useState("");
  const [notes, setNotes] = useState("");
  const [items, setItems] = useState<Item[]>([
    { product_id: "", quantity_requested: 1 },
  ]);
  const [submitting, setSubmitting] = useState(false);
  const [scanCode, setScanCode] = useState("");
  const [scanFlash, setScanFlash] = useState<string | null>(null);

  // Deep-link prefill from product form
  useEffect(() => {
    const productId = searchParams.get("product");
    if (productId) {
      setItems([{ product_id: productId, quantity_requested: 1 }]);
    }
  }, [searchParams]);

  const handleScanLine = async (code: string) => {
    const norm = code.trim();
    if (!norm) return;
    setScanCode("");
    const flash = (msg: string, ms = 2500) => {
      setScanFlash(msg);
      window.setTimeout(() => setScanFlash(null), ms);
    };

    const resolved = await resolveIdentity(norm);
    if (resolved.kind !== "resolved" && resolved.kind !== "not_found") {
      flash(
        identityOutcomeLine({
          status: resolved.kind,
          code: norm,
          matchCount: resolved.kind === "ambiguous" ? resolved.matchCount : undefined,
        }),
        3500,
      );
      return;
    }

    let productId: string | null = null;
    let name = norm;
    let step = 1;
    if (resolved.kind === "resolved") {
      productId = resolved.identity.productId;
      name = resolved.identity.productName;
      step = Math.max(1, Math.round(resolved.identity.qtyInBaseUom || 1));
    } else {
      const match = inventoryProducts.find(
        (p: any) => p.sku && p.sku.toLowerCase() === norm.toLowerCase(),
      );
      if (!match) {
        flash(`No product matches "${norm}"`);
        return;
      }
      productId = match.id;
      name = match.name;
    }

    setItems((prev) => {
      const idx = prev.findIndex((i) => i.product_id === productId);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = {
          ...next[idx],
          quantity_requested: (next[idx].quantity_requested || 0) + step,
        };
        return next;
      }
      const trailingEmpty =
        prev.length > 0 && !prev[prev.length - 1].product_id;
      const base = trailingEmpty ? prev.slice(0, -1) : prev;
      return [...base, { product_id: productId!, quantity_requested: step }];
    });
    flash(`+${step} ${name}`, 1500);
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!fromWarehouseId || !toWarehouseId) {
      toast.error("Pick source and destination warehouses");
      return;
    }
    if (fromWarehouseId === toWarehouseId) {
      toast.error("Source and destination must differ");
      return;
    }
    const filtered = items.filter(
      (i) => i.product_id && i.quantity_requested > 0,
    );
    if (filtered.length === 0) {
      toast.error("Add at least one product to transfer");
      return;
    }
    setSubmitting(true);
    try {
      await createStockTransfer(
        fromWarehouseId,
        toWarehouseId,
        filtered,
        notes || undefined,
      );
      navigate("/inventory-app/transfers");
    } catch {
      // toast already raised in hook
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <RecordFormShell
      mode="create"
      entityLabel="Stock Transfer"
      cancelHref="/inventory-app/transfers"
      onSubmit={handleSubmit}
      isSubmitting={submitting}
      submitLabel="Create transfer"
    >
      <Section
        title="Locations"
        description="Stock leaves the source on dispatch and enters the destination on receive. Quantities are validated against on-hand when you dispatch."
      >
        <FieldGrid columns={2}>
          <div className="space-y-2">
            <Label>From warehouse *</Label>
            <Select value={fromWarehouseId} onValueChange={setFromWarehouseId}>
              <SelectTrigger>
                <SelectValue placeholder="Source" />
              </SelectTrigger>
              <SelectContent>
                {warehouses.map((w) => (
                  <SelectItem key={w.id} value={w.id}>
                    {w.name} ({w.code})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>To warehouse *</Label>
            <Select value={toWarehouseId} onValueChange={setToWarehouseId}>
              <SelectTrigger>
                <SelectValue placeholder="Destination" />
              </SelectTrigger>
              <SelectContent>
                {warehouses
                  .filter((w) => w.id !== fromWarehouseId)
                  .map((w) => (
                    <SelectItem key={w.id} value={w.id}>
                      {w.name} ({w.code})
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
        </FieldGrid>
      </Section>

      <Section
        title="Items"
        description="Scan barcodes or pick products manually. Each line will be dispatched from the source warehouse."
      >
        <div className="mb-3 flex items-center justify-end gap-2">
          <ScannerPairingButton
            businessId={currentBusiness?.id}
            branchId={currentBranch?.id ?? null}
            label="Stock transfer"
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() =>
              setItems([...items, { product_id: "", quantity_requested: 1 }])
            }
          >
            <Plus className="mr-1 h-3 w-3" /> Add line
          </Button>
        </div>

        <div className="mb-3">
          <BarcodeInputField
            value={scanCode}
            onChange={setScanCode}
            onScan={handleScanLine}
            businessId={currentBusiness?.id}
            branchId={currentBranch?.id ?? null}
            allowRepeats
            workflow="quantity"
            fieldLabel="Transfer line"
            placeholder="Scan a barcode to add or increment a line"
          />
          {scanFlash && (
            <p className="mt-1 text-xs text-muted-foreground">{scanFlash}</p>
          )}
        </div>

        <div className="space-y-2">
          {items.map((it, idx) => (
            <div
              key={idx}
              className="grid grid-cols-[1fr_120px_40px] items-center gap-2"
            >
              <Select
                value={it.product_id}
                onValueChange={(v) => {
                  const next = [...items];
                  next[idx] = { ...next[idx], product_id: v };
                  setItems(next);
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Product" />
                </SelectTrigger>
                <SelectContent>
                  {inventoryProducts.map((p: any) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                type="number"
                min="0"
                step="any"
                value={it.quantity_requested}
                onChange={(e) => {
                  const next = [...items];
                  next[idx] = {
                    ...next[idx],
                    quantity_requested: Number(e.target.value) || 0,
                  };
                  setItems(next);
                }}
              />
              <Button
                type="button"
                size="icon"
                variant="ghost"
                onClick={() =>
                  setItems(items.filter((_, i) => i !== idx))
                }
                disabled={items.length === 1}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Notes">
        <div className="space-y-2">
          <Label>Notes (optional)</Label>
          <Input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Reason / reference"
          />
        </div>
      </Section>
    </RecordFormShell>
  );
}