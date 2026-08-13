/**
 * ProductPhysicalAttributesEditor — captures the canonical physical facts of a
 * product (net / packaging weight, volume, dimensions) per measurement level:
 * the base inventory unit plus any persisted packaging level.
 *
 * Mirrors ProductPackagingEditor's two modes:
 *   1. Edit mode  (productId given) — loads levels, "Save measurements" persists.
 *   2. Create mode (productId null) — buffers the base level; the parent calls
 *      the imperative `commit(newProductId)` after the product row exists.
 *
 * The browser does no physical maths: gross weight is derived and every
 * invariant (unit dimension, tenant, packaging ownership, gross = net + tare)
 * is enforced by the database. Landed Cost, Warehouse and Logistics read these
 * facts through `resolve_product_measure` and never store their own copies.
 */
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useState,
} from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { UomSelect } from "@/components/products/UomSelect";
import {
  emptyRow,
  isRowEmpty,
  loadPhysicalAttributes,
  persistPhysicalAttributes,
  type PhysicalAttributeRow,
} from "@/features/products/physical/physicalAttributes";

export interface ProductPhysicalAttributesEditorHandle {
  /** Persist buffered levels after the parent creates the product. */
  commit: (productId: string) => Promise<void>;
  hasPending: () => boolean;
}

interface Props {
  productId: string | null;
  organizationId: string;
  businessId: string;
}

type PackLevel = { id: string; name: string; qty: number };

const num = (v: string): number | null => {
  if (v.trim() === "") return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

export const ProductPhysicalAttributesEditor = forwardRef<
  ProductPhysicalAttributesEditorHandle,
  Props
>(function ProductPhysicalAttributesEditor(
  { productId, organizationId, businessId },
  ref,
) {
  const [rows, setRows] = useState<PhysicalAttributeRow[]>([emptyRow(null)]);
  const [levels, setLevels] = useState<PackLevel[]>([]);
  const [loading, setLoading] = useState(false);
  const [dirty, setDirty] = useState(false);

  const isCreateMode = !productId;

  useEffect(() => {
    if (!productId) return;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId]);

  async function load() {
    if (!productId) return;
    setLoading(true);
    try {
      const [attrs, packsRes] = await Promise.all([
        loadPhysicalAttributes(productId),
        supabase
          .from("product_packaging")
          .select("id, name, qty_in_base_uom")
          .eq("product_id", productId)
          .order("qty_in_base_uom", { ascending: true }),
      ]);
      if (packsRes.error) throw new Error(packsRes.error.message);
      const packLevels: PackLevel[] = (packsRes.data ?? []).map((p) => ({
        id: p.id,
        name: p.name,
        qty: Number(p.qty_in_base_uom),
      }));
      setLevels(packLevels);
      const byLevel = new Map(attrs.map((a) => [a.packagingId ?? "__base__", a]));
      setRows([
        byLevel.get("__base__") ?? emptyRow(null),
        ...packLevels.map((l) => byLevel.get(l.id) ?? emptyRow(l.id)),
      ]);
      setDirty(false);
    } catch (err) {
      toast.error(
        `Failed to load physical attributes: ${(err as Error).message}`,
      );
    } finally {
      setLoading(false);
    }
  }

  function update(idx: number, patch: Partial<PhysicalAttributeRow>) {
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
    setDirty(true);
  }

  async function save() {
    if (!productId) {
      toast.error("Save the product first, then capture measurements.");
      return;
    }
    setLoading(true);
    try {
      await persistPhysicalAttributes({
        organizationId,
        businessId,
        productId,
        rows,
      });
      toast.success("Physical attributes saved.");
      void load();
    } catch (err) {
      toast.error(`Save failed: ${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  }

  useImperativeHandle(
    ref,
    () => ({
      async commit(newProductId: string) {
        if (rows.every(isRowEmpty)) return;
        await persistPhysicalAttributes({
          organizationId,
          businessId,
          productId: newProductId,
          // Packaging levels get their own ids only after packaging commits;
          // on create we persist the base level and let the operator capture
          // pack-level measurements on the saved product.
          rows: rows.filter((r) => r.packagingId === null),
        });
      },
      hasPending() {
        return isCreateMode && rows.some((r) => !isRowEmpty(r));
      },
    }),
    [rows, isCreateMode, organizationId, businessId],
  );

  function levelLabel(row: PhysicalAttributeRow): string {
    if (row.packagingId === null) return "Base inventory unit";
    const level = levels.find((l) => l.id === row.packagingId);
    return level ? `${level.name} (×${level.qty} base)` : "Packaging level";
  }

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <p className="text-xs text-muted-foreground max-w-2xl">
          Weight and volume are what freight, duty and handling costs are
          allocated by, and what shipping and warehouse capacity are planned
          from. Capture them once here: every other module reads these values
          and converts them itself. Gross weight is calculated as net plus
          packaging weight.
        </p>
        {!isCreateMode && (
          <Button
            type="button"
            size="sm"
            onClick={save}
            disabled={loading || !dirty}
          >
            Save measurements
          </Button>
        )}
      </div>

      {rows.map((row, idx) => (
        <div
          key={row.packagingId ?? "__base__"}
          className="space-y-3 rounded-md border p-3"
        >
          <div className="flex items-center justify-between">
            <Label className="text-sm font-medium">{levelLabel(row)}</Label>
            {row.grossWeight != null && (
              <span className="text-xs text-muted-foreground">
                Gross weight on file: {row.grossWeight}
              </span>
            )}
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label className="text-xs">Net weight</Label>
                <Input
                  type="number"
                  step="0.001"
                  min="0"
                  value={row.netWeight ?? ""}
                  onChange={(e) => update(idx, { netWeight: num(e.target.value) })}
                />
              </div>
              <div>
                <Label className="text-xs">Weight unit</Label>
                <UomSelect
                  dimension="mass"
                  allowClear
                  value={row.netWeightUomId}
                  onChange={(id) => update(idx, { netWeightUomId: id })}
                  placeholder="kg, g, lb…"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label className="text-xs">Packaging (tare) weight</Label>
                <Input
                  type="number"
                  step="0.001"
                  min="0"
                  value={row.tareWeight ?? ""}
                  onChange={(e) => update(idx, { tareWeight: num(e.target.value) })}
                />
              </div>
              <div>
                <Label className="text-xs">Tare unit</Label>
                <UomSelect
                  dimension="mass"
                  allowClear
                  value={row.tareWeightUomId}
                  onChange={(id) => update(idx, { tareWeightUomId: id })}
                  placeholder="kg, g, lb…"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label className="text-xs">Volume</Label>
                <Input
                  type="number"
                  step="0.0001"
                  min="0"
                  value={row.volume ?? ""}
                  onChange={(e) => update(idx, { volume: num(e.target.value) })}
                />
              </div>
              <div>
                <Label className="text-xs">Volume unit</Label>
                <UomSelect
                  dimension="volume"
                  allowClear
                  value={row.volumeUomId}
                  onChange={(id) => update(idx, { volumeUomId: id })}
                  placeholder="L, mL, m³…"
                />
              </div>
            </div>

            <div className="grid grid-cols-4 gap-2">
              <div>
                <Label className="text-xs">Length</Label>
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  value={row.length ?? ""}
                  onChange={(e) => update(idx, { length: num(e.target.value) })}
                />
              </div>
              <div>
                <Label className="text-xs">Width</Label>
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  value={row.width ?? ""}
                  onChange={(e) => update(idx, { width: num(e.target.value) })}
                />
              </div>
              <div>
                <Label className="text-xs">Height</Label>
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  value={row.height ?? ""}
                  onChange={(e) => update(idx, { height: num(e.target.value) })}
                />
              </div>
              <div>
                <Label className="text-xs">Unit</Label>
                <UomSelect
                  dimension="length"
                  allowClear
                  value={row.dimensionUomId}
                  onChange={(id) => update(idx, { dimensionUomId: id })}
                  placeholder="cm, mm…"
                />
              </div>
            </div>
          </div>
        </div>
      ))}

      {isCreateMode && (
        <p className="text-xs text-muted-foreground">
          Pack-level measurements (carton, pallet) can be captured after the
          product is saved. Until then, packs inherit the base unit measurement
          multiplied by the pack size.
        </p>
      )}
    </div>
  );
});
