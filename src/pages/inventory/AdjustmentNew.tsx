/**
 * Stock Adjustment — routed create surface.
 *
 * Migrates the "Create Stock Adjustment" dialog from `src/pages/Inventory.tsx`
 * to a dedicated `/inventory-app/adjustments/new` route composed on top of
 * `RecordFormShell` — the enterprise standard for record create pages.
 *
 * Preserves:
 *   - warehouse pre-selection (branch default → single → org default)
 *   - unit_cost prefill from product master (deep-link + post-load backfill)
 *   - server-side cost validation and offset-account hint
 *   - deep-link `?product=<id>` (previously `?action=adjust&product=<id>`
 *     on `/inventory-app/stock`)
 */
import {
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useInventory, useOffsetAccountPreview } from "@/hooks/useInventory";
import { useProducts } from "@/hooks/useProducts";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranches } from "@/hooks/useBranches";
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
import { Plus, XCircle } from "lucide-react";
import { toast } from "sonner";
import { RecordFormShell, Section, FieldGrid } from "@/design-system";
import { productBaseLabelOrUnset } from "@/lib/inventory/uom";

type Item = {
  product_id: string;
  quantity_adjustment: number;
  unit_cost: number | "";
  notes: string;
};

type Warehouse = {
  id: string;
  name: string;
  is_default: boolean | null;
  branch_id: string | null;
};

export default function AdjustmentNew() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { createStockAdjustment } = useInventory();
  const { products } = useProducts();
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranches();

  const organizationId = currentOrg?.id;
  const businessId = currentBusiness?.id;
  const branchId = currentBranch?.id;

  const inventoryProducts = useMemo(
    () => products.filter((p: any) => p.type === "product"),
    [products],
  );

  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  useEffect(() => {
    if (!organizationId) return;
    let q = supabase
      .from("warehouses")
      .select("id, name, is_default, branch_id")
      .eq("organization_id", organizationId)
      .eq("is_active", true)
      // In-transit buckets are bookkeeping, never an adjustment target.
      .or("is_in_transit.is.null,is_in_transit.eq.false");

    if (businessId) q = q.eq("business_id", businessId);
    if (branchId) q = q.eq("branch_id", branchId);
    q.then(({ data }) => setWarehouses((data as Warehouse[]) || []));
  }, [organizationId, businessId, branchId]);

  const [warehouseId, setWarehouseId] = useState("");
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");
  const [items, setItems] = useState<Item[]>([]);
  const [submitting, setSubmitting] = useState(false);

  // Deep-link prefill from Products.tsx: ?product=<id> [&reason=<code>]
  useEffect(() => {
    const productId = searchParams.get("product");
    if (!productId) {
      if (items.length === 0) {
        setItems([
          { product_id: "", quantity_adjustment: 0, unit_cost: "", notes: "" },
        ]);
      }
      return;
    }
    const prod = inventoryProducts.find((p: any) => p.id === productId) as any;
    const prefilledCost: number | "" =
      prod && Number(prod.cost_price) > 0 ? Number(prod.cost_price) : "";
    setReason((r) => r || searchParams.get("reason") || "opening_balance");
    setItems((prev) =>
      prev.some((i) => i.product_id === productId)
        ? prev
        : [
            {
              product_id: productId,
              quantity_adjustment: 0,
              unit_cost: prefilledCost,
              notes: "",
            },
          ],
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, inventoryProducts]);

  // Warehouse auto-select: branch default → single → org default.
  useEffect(() => {
    if (warehouseId || warehouses.length === 0) return;
    const branchDefault = branchId
      ? warehouses.find((w) => w.branch_id === branchId && w.is_default)
      : undefined;
    if (branchDefault) return setWarehouseId(branchDefault.id);
    if (warehouses.length === 1) return setWarehouseId(warehouses[0].id);
    const orgDefault = warehouses.find((w) => w.is_default);
    if (orgDefault) setWarehouseId(orgDefault.id);
  }, [warehouseId, warehouses, branchId]);

  // Backfill unit_cost from product master once products load.
  useEffect(() => {
    if (items.length === 0 || inventoryProducts.length === 0) return;
    let changed = false;
    const next = items.map((it) => {
      const c =
        typeof it.unit_cost === "number" ? it.unit_cost : Number(it.unit_cost);
      if (it.product_id && (!Number.isFinite(c) || c <= 0)) {
        const prod = inventoryProducts.find(
          (p: any) => p.id === it.product_id,
        ) as any;
        const cp = prod && Number(prod.cost_price);
        if (cp && cp > 0) {
          changed = true;
          return { ...it, unit_cost: cp };
        }
      }
      return it;
    });
    if (changed) setItems(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inventoryProducts]);

  const updateItem = (
    index: number,
    field: keyof Item,
    value: string | number,
  ) => {
    const next = [...items];
    next[index] = { ...next[index], [field]: value } as Item;
    if (field === "product_id" && typeof value === "string") {
      const prod = inventoryProducts.find((p: any) => p.id === value) as any;
      if (prod && prod.cost_price && !next[index].unit_cost) {
        next[index].unit_cost = Number(prod.cost_price);
      }
    }
    setItems(next);
  };

  const addItem = () =>
    setItems([
      ...items,
      { product_id: "", quantity_adjustment: 0, unit_cost: "", notes: "" },
    ]);

  const removeItem = (index: number) =>
    setItems(items.filter((_, i) => i !== index));

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!reason) {
      toast.error("Pick an adjustment reason");
      return;
    }
    if (!warehouseId) {
      toast.error("Pick the warehouse you are adjusting before submitting");
      return;
    }
    const filtered = items.filter(
      (i) => i.product_id && i.quantity_adjustment !== 0,
    );
    if (filtered.length === 0) {
      toast.error("Add at least one product line with a non-zero quantity");
      return;
    }
    const missingCost = filtered.find((i) => {
      const c =
        typeof i.unit_cost === "number" ? i.unit_cost : Number(i.unit_cost);
      return !Number.isFinite(c) || c <= 0;
    });
    if (missingCost) {
      const prod = inventoryProducts.find(
        (p: any) => p.id === missingCost.product_id,
      ) as any;
      toast.error(
        `Enter a unit cost for "${prod?.name ?? "this line"}". Inventory adjustments must post a valuation to the general ledger.`,
      );
      return;
    }
    setSubmitting(true);
    try {
      await createStockAdjustment.mutateAsync({
        reason,
        notes,
        items: filtered.map((i) => ({
          product_id: i.product_id,
          quantity_adjustment: i.quantity_adjustment,
          unit_cost:
            typeof i.unit_cost === "number" ? i.unit_cost : Number(i.unit_cost),
          notes: i.notes,
          warehouse_id: warehouseId,
        })),
      });
      navigate("/inventory-app/stock");
    } catch (err: any) {
      console.error("Stock adjustment failed", err);
      const msg = err?.message || err?.error?.message || "Unknown error";
      toast.error(`Could not adjust stock: ${msg}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <RecordFormShell
      mode="create"
      entityLabel="Stock Adjustment"
      cancelHref="/inventory-app/stock"
      onSubmit={handleSubmit}
      isSubmitting={submitting}
      submitDisabled={!reason || !warehouseId || items.length === 0}
      submitLabel="Create adjustment"
    >
      <Section
        title="Adjustment"
        description="A single adjustment posts one journal entry against the selected warehouse. All lines must belong to the same warehouse."
      >
        <FieldGrid columns={2}>
          <div className="space-y-2">
            <Label>Warehouse *</Label>
            {warehouses.length === 0 ? (
              <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                No warehouse exists in this scope yet.{" "}
                <Link
                  to="/warehouse-app/warehouses/new"
                  className="text-primary underline"
                >
                  Create one first
                </Link>{" "}
                to enable stock adjustments.
              </div>
            ) : (
              <Select value={warehouseId} onValueChange={setWarehouseId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select warehouse" />
                </SelectTrigger>
                <SelectContent>
                  {warehouses.map((w) => (
                    <SelectItem key={w.id} value={w.id}>
                      {w.name}
                      {w.is_default ? " (default)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <p className="text-xs text-muted-foreground">
              All lines in one adjustment must come from the same warehouse
              {currentBranch ? ` (showing only ${currentBranch.name})` : ""}.
            </p>
          </div>
          <div className="space-y-2">
            <Label>Reason *</Label>
            <Select value={reason} onValueChange={setReason}>
              <SelectTrigger>
                <SelectValue placeholder="Select adjustment reason" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="shrinkage">Shrinkage / Theft</SelectItem>
                <SelectItem value="damage">Damage</SelectItem>
                <SelectItem value="count_variance">Count Variance</SelectItem>
                <SelectItem value="found_stock">Found Stock</SelectItem>
                <SelectItem value="write_off">Write-off</SelectItem>
                <SelectItem value="revaluation">Revaluation</SelectItem>
                <SelectItem value="opening_balance">Opening Balance</SelectItem>
              </SelectContent>
            </Select>
            <OffsetAccountHint reason={reason} />
          </div>
        </FieldGrid>
        <div className="space-y-2">
          <Label>Notes</Label>
          <Input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Additional notes"
          />
        </div>
      </Section>

      <Section
        title="Items"
        description="Enter a positive quantity to increase on-hand or a negative quantity to decrease. Unit cost drives the general-ledger valuation."
      >
        <div className="mb-3 flex items-center justify-end">
          <Button type="button" variant="outline" size="sm" onClick={addItem}>
            <Plus className="mr-1 h-3 w-3" /> Add line
          </Button>
        </div>
        <div className="space-y-2">
          {items.map((item, index) => {
            const selProd = inventoryProducts.find(
              (p: any) => p.id === item.product_id,
            ) as any;
            const baseLabel = productBaseLabelOrUnset(selProd);
            return (
              <div
                key={index}
                className="space-y-3 rounded-lg border p-3"
              >
                <div>
                  <Label className="mb-1 block text-xs text-muted-foreground">
                    Product
                  </Label>
                  <Select
                    value={item.product_id}
                    onValueChange={(v) => updateItem(index, "product_id", v)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select product" />
                    </SelectTrigger>
                    <SelectContent>
                      {inventoryProducts.map((p: any) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-[7rem_8rem_1fr]">
                  <div>
                    <Label className="mb-1 block text-xs text-muted-foreground">
                      Qty (+/-){" "}
                      <span className="text-muted-foreground/70">
                        [{baseLabel}]
                      </span>
                    </Label>
                    <Input
                      type="number"
                      value={item.quantity_adjustment}
                      onChange={(e) =>
                        updateItem(
                          index,
                          "quantity_adjustment",
                          parseFloat(e.target.value) || 0,
                        )
                      }
                      placeholder={`Qty in ${baseLabel}`}
                    />
                  </div>
                  <div>
                    <Label className="mb-1 block text-xs text-muted-foreground">
                      Unit cost *
                    </Label>
                    <Input
                      type="number"
                      step="0.0001"
                      min="0"
                      value={item.unit_cost}
                      onChange={(e) =>
                        updateItem(
                          index,
                          "unit_cost",
                          e.target.value === ""
                            ? ""
                            : parseFloat(e.target.value) || 0,
                        )
                      }
                      placeholder="Cost"
                    />
                  </div>
                  <div>
                    <Label className="mb-1 block text-xs text-muted-foreground">
                      Notes
                    </Label>
                    <Input
                      value={item.notes}
                      onChange={(e) =>
                        updateItem(index, "notes", e.target.value)
                      }
                      placeholder="Line notes"
                    />
                  </div>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="self-end"
                  onClick={() => removeItem(index)}
                >
                  <XCircle className="h-4 w-4" />
                </Button>
              </div>
            );
          })}
          {items.length === 0 && (
            <p className="py-4 text-center text-sm text-muted-foreground">
              Click "Add line" to add products to adjust
            </p>
          )}
        </div>
      </Section>
    </RecordFormShell>
  );
}

/**
 * Wave 5 G6 — read-only hint under the reason picker showing which GL
 * offset account the chosen reason will post to. Pure transparency.
 */
function OffsetAccountHint({ reason }: { reason: string }) {
  const { data, isLoading } = useOffsetAccountPreview(reason || null);
  if (!reason) {
    return (
      <p className="text-xs text-muted-foreground">
        The reason drives the offset account on the journal entry.
      </p>
    );
  }
  if (isLoading) {
    return (
      <p className="text-xs text-muted-foreground">
        Resolving offset account…
      </p>
    );
  }
  if (!data) {
    return (
      <p className="text-xs text-muted-foreground">
        The reason drives the offset account on the journal entry.
      </p>
    );
  }
  return (
    <p className="text-xs text-muted-foreground">
      Posts contra to{" "}
      <span className="font-medium text-foreground">
        {data.account_code} — {data.account_name}
      </span>
      .
    </p>
  );
}
