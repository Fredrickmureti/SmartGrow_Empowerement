/**
 * ProductPackagingEditor — manages rows of `product_packaging` for a product.
 *
 * Two modes (mirrors ProductIdentifiersEditor):
 *
 *   1. Edit mode (productId provided): loads existing rows and persists
 *      Add / Update / Delete immediately.
 *
 *   2. Create mode (productId == null): buffers rows in local state. Call
 *      the imperative ref method `commit(newProductId)` from the parent
 *      after the product row is inserted to flush them in one batch.
 *
 * Templates menu: one-click presets for common industry pack hierarchies
 * (pharmacy, retail, beverage, agriculture, hardware). Industry-neutral so
 * the core editor never imposes one vertical's vocabulary on the user.
 * Barcode binding (product_identifiers.packaging_id) is edit-mode only — the
 * picker needs persisted product_identifiers rows. Pending rows can still
 * be bound later by re-opening the product.
 */
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useState,
} from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { toast } from "sonner";
import { Trash2, Plus, LayoutTemplate, Sparkles } from "lucide-react";
import { useIndustryProfile } from "@/hooks/useIndustryProfile";
import { writeIdentifier } from "@/features/products/identity/writeIdentifier";

type PackRow = {
  id: string;
  name: string;
  qty_in_base_uom: number;
  is_purchase_default: boolean;
  is_sales_default: boolean;
  _dirty?: boolean;
  _new?: boolean;
};

type BarcodeRow = {
  id: string;
  code: string;
  kind: string;
  packaging_id: string | null;
};

export interface ProductPackagingEditorHandle {
  /** Persist pending rows after the parent creates the product. */
  commit: (productId: string) => Promise<void>;
  /**
   * Payload for the single-transaction product save
   * (`save_product_atomic`). Only edited/new levels are sent; untouched rows
   * are left alone.
   */
  collect: () => PackagingInput[];
  /** True if create-mode buffer holds at least one row. */
  hasPending: () => boolean;
}

interface Props {
  productId: string | null;
  organizationId: string;
  businessId: string;
}

export const ProductPackagingEditor = forwardRef<
  ProductPackagingEditorHandle,
  Props
>(function ProductPackagingEditor({ productId, organizationId, businessId }, ref) {
  const [rows, setRows] = useState<PackRow[]>([]);
  const [barcodes, setBarcodes] = useState<BarcodeRow[]>([]);
  const [loading, setLoading] = useState(false);
  const { profile: industryProfile } = useIndustryProfile();
  const recommendedTemplate = industryProfile.packTemplate ?? null;

  const isCreateMode = !productId;

  useEffect(() => {
    if (!productId) {
      // Entering create mode (or product cleared) — keep buffer intact so
      // operator doesn't lose pack rows if the dialog re-renders.
      return;
    }
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId]);

  async function load() {
    if (!productId) return;
    setLoading(true);
    const [packsRes, barcodesRes] = await Promise.all([
      supabase
        .from("product_packaging")
        .select("id, name, qty_in_base_uom, is_purchase_default, is_sales_default")
        .eq("product_id", productId)
        .order("qty_in_base_uom", { ascending: true }),
      supabase
        .from("product_identifiers")
        .select("id, code, kind, packaging_id")
        .eq("product_id", productId)
        .order("code", { ascending: true }),
    ]);
    setLoading(false);
    if (packsRes.error) {
      toast.error(`Failed to load packaging: ${packsRes.error.message}`);
      return;
    }
    if (barcodesRes.error) {
      toast.error(`Failed to load barcodes: ${barcodesRes.error.message}`);
    }
    setRows(
      (packsRes.data ?? []).map((r) => ({
        id: r.id,
        name: r.name,
        qty_in_base_uom: Number(r.qty_in_base_uom),
        is_purchase_default: !!r.is_purchase_default,
        is_sales_default: !!r.is_sales_default,
      })),
    );
    setBarcodes(
      (barcodesRes.data ?? []).map((b: any) => ({
        id: b.id,
        code: b.code,
        kind: b.kind,
        packaging_id: b.packaging_id ?? null,
      })),
    );
  }

  /**
   * Phase D — the identifier→level link now lives on
   * `product_identifiers.packaging_id`; `product_packaging.barcode_id`
   * (the inverse, drift-prone copy) is gone. The picker below still reads
   * "bind a barcode to this level", but it writes the canonical side.
   */
  function identifierForLevel(levelId: string): string | null {
    return barcodes.find((b) => b.packaging_id === levelId)?.id ?? null;
  }

  async function bindIdentifierToLevel(levelId: string, identifierId: string | null) {
    const previous = identifierForLevel(levelId);
    if (!productId) return;
    // Optimistic: one identifier per level in this picker.
    setBarcodes((prev) =>
      prev.map((b) => {
        if (b.id === previous) return { ...b, packaging_id: null };
        if (b.id === identifierId) return { ...b, packaging_id: levelId };
        return b;
      }),
    );
    if (previous && previous !== identifierId) {
      const row = barcodes.find((b) => b.id === previous);
      const failure = row
        ? await writeIdentifier({
            businessId,
            productId,
            identifierId: previous,
            code: row.code,
            kind: row.kind,
            packagingId: null,
          })
        : "That identifier no longer exists — refresh and try again.";
      if (failure) {
        toast.error(failure);
        void load();
        return;
      }
    }
    if (identifierId) {
      const row = barcodes.find((b) => b.id === identifierId);
      const failure = row
        ? await writeIdentifier({
            businessId,
            productId,
            identifierId,
            code: row.code,
            kind: row.kind,
            packagingId: levelId,
          })
        : "That identifier no longer exists — refresh and try again.";
      if (failure) {
        toast.error(failure);
        void load();
        return;
      }
    }
  }

  function update(idx: number, patch: Partial<PackRow>) {
    setRows((prev) =>
      prev.map((r, i) => (i === idx ? { ...r, ...patch, _dirty: true } : r)),
    );
  }

  function addRow() {
    setRows((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        name: "",
        qty_in_base_uom: 1,
        is_purchase_default: false,
        is_sales_default: false,
        _new: true,
        _dirty: true,
      },
    ]);
  }

  /**
   * Industry pack templates — pre-fill common pack hierarchies. Each entry
   * is just a list of (name, multiplier, purchase-default, sales-default)
   * tuples. Picking a template merges with existing rows (skips duplicates
   * by lowercased name) so an operator can stack templates safely.
   *
   * Keep this list industry-neutral: ship as many verticals as we support
   * onboarding for. NEVER hard-code one industry's vocabulary into the core
   * editor — operators in agriculture, retail, beverages, etc. should each
   * see their own canonical pack hierarchy as a one-click starting point.
   */
  const PACK_TEMPLATES: Record<
    string,
    { label: string; packs: Array<{ name: string; qty: number; purchase: boolean; sales: boolean }> }
  > = {
    pharmacy: {
      label: "Pharmacy — Strip ×10, Box ×50",
      packs: [
        { name: "Strip", qty: 10, purchase: false, sales: true },
        { name: "Box", qty: 50, purchase: true, sales: false },
      ],
    },
    retail: {
      label: "Retail — Inner ×6, Carton ×24",
      packs: [
        { name: "Inner", qty: 6, purchase: false, sales: true },
        { name: "Carton", qty: 24, purchase: true, sales: false },
      ],
    },
    beverage: {
      label: "Beverage — Six-pack ×6, Case ×24",
      packs: [
        { name: "Six-pack", qty: 6, purchase: false, sales: true },
        { name: "Case", qty: 24, purchase: true, sales: false },
      ],
    },
    agriculture: {
      label: "Agriculture — Bag ×25, Pallet ×40 bags",
      packs: [
        { name: "Bag", qty: 25, purchase: false, sales: true },
        { name: "Pallet", qty: 1000, purchase: true, sales: false },
      ],
    },
    hardware: {
      label: "Hardware — Pack ×12, Box ×144",
      packs: [
        { name: "Pack", qty: 12, purchase: false, sales: true },
        { name: "Box", qty: 144, purchase: true, sales: false },
      ],
    },
  };

  function applyTemplate(key: keyof typeof PACK_TEMPLATES) {
    const tmpl = PACK_TEMPLATES[key];
    setRows((prev) => {
      const existing = new Set(prev.map((r) => r.name.toLowerCase().trim()));
      const additions: PackRow[] = [];
      for (const p of tmpl.packs) {
        if (existing.has(p.name.toLowerCase())) continue;
        additions.push({
          id: crypto.randomUUID(),
          name: p.name,
          qty_in_base_uom: p.qty,
          is_purchase_default: p.purchase,
          is_sales_default: p.sales,
          _new: true,
          _dirty: true,
        });
      }
      if (additions.length === 0) {
        toast.info("Those packs are already defined.");
        return prev;
      }
      toast.success(`Added ${additions.length} pack(s) from ${tmpl.label}.`);
      return [...prev, ...additions];
    });
  }

  async function removeRow(idx: number) {
    const row = rows[idx];
    if (!row._new && !isCreateMode) {
      const { error } = await supabase.from("product_packaging").delete().eq("id", row.id);
      if (error) {
        toast.error(`Failed to delete: ${error.message}`);
        return;
      }
    }
    setRows((prev) => prev.filter((_, i) => i !== idx));
  }

  async function persistRows(targetProductId: string, rowsToPersist: PackRow[]) {
    const dirty = rowsToPersist.filter((r) => r._dirty);
    if (dirty.length === 0) return;
    for (const r of dirty) {
      if (!r.name.trim() || !(r.qty_in_base_uom > 0)) {
        throw new Error("Each pack needs a name and a positive base-unit quantity.");
      }
    }
    const payload = dirty.map((r) => {
      const base = {
        product_id: targetProductId,
        organization_id: organizationId,
        business_id: businessId,
        name: r.name.trim(),
        qty_in_base_uom: r.qty_in_base_uom,
        is_purchase_default: r.is_purchase_default,
        is_sales_default: r.is_sales_default,
      };
      return r._new ? base : { id: r.id, ...base };
    });
    // Upsert requires uniform columns across rows; split new vs existing so
    // PostgREST doesn't send a null `id` for new rows (the table has no
    // default on id, so that triggers a not-null violation).
    const newRows = payload.filter((p) => !("id" in p));
    const existingRows = payload.filter((p) => "id" in p);
    if (newRows.length > 0) {
      const { error } = await supabase.from("product_packaging").insert(newRows as any);
      if (error) throw new Error(error.message);
    }
    const { error } = existingRows.length > 0
      ? await supabase.from("product_packaging").upsert(existingRows as any)
      : { error: null as any };
    if (error) throw new Error(error.message);
  }

  async function saveAll() {
    if (!productId) {
      toast.error("Save the product first, then add packaging.");
      return;
    }
    const dirty = rows.filter((r) => r._dirty);
    if (dirty.length === 0) {
      toast.info("No changes to save.");
      return;
    }
    setLoading(true);
    try {
      await persistRows(productId, rows);
      toast.success(`Saved ${dirty.length} packaging row(s).`);
      void load();
    } catch (err: any) {
      toast.error(`Save failed: ${err?.message ?? "Unknown error"}`);
    } finally {
      setLoading(false);
    }
  }

  useImperativeHandle(ref, () => ({
    async commit(newProductId: string) {
      if (rows.length === 0) return;
      await persistRows(newProductId, rows);
    },
    collect(): PackagingInput[] {
      return rows
        .filter((r) => r._dirty)
        .map((r) => ({
          ...(r._new ? {} : { id: r.id }),
          name: r.name.trim(),
          qty_in_base_uom: r.qty_in_base_uom,
          is_purchase_default: r.is_purchase_default,
          is_sales_default: r.is_sales_default,
        }));
    },
    hasPending() {
      return isCreateMode && rows.some((r) => r._dirty);
    },
  }), [rows, isCreateMode, organizationId, businessId]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <Label className="text-sm font-medium">Packaging (cartons, packs, strips)</Label>
          <p className="text-xs text-muted-foreground">
            Define every pack you buy or sell. Each pack is a multiplier of the
            base unit — e.g. Strip ×10 tablets, Box ×50 tablets.
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" size="sm" variant="ghost">
                <LayoutTemplate className="mr-1 h-3.5 w-3.5" /> Templates
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuLabel>Industry pack templates</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {Object.entries(PACK_TEMPLATES)
                .sort(([a], [b]) =>
                  a === recommendedTemplate
                    ? -1
                    : b === recommendedTemplate
                      ? 1
                      : 0,
                )
                .map(([key, t]) => (
                  <DropdownMenuItem
                    key={key}
                    onClick={() => applyTemplate(key as keyof typeof PACK_TEMPLATES)}
                  >
                    {key === recommendedTemplate && (
                      <Sparkles className="mr-1 h-3.5 w-3.5 text-primary" />
                    )}
                    <span className="flex-1">{t.label}</span>
                    {key === recommendedTemplate && (
                      <span className="ml-2 text-[10px] uppercase tracking-wide text-primary">
                        Recommended
                      </span>
                    )}
                  </DropdownMenuItem>
                ))}

            </DropdownMenuContent>
          </DropdownMenu>
          <Button type="button" size="sm" variant="outline" onClick={addRow}>
            <Plus className="mr-1 h-3.5 w-3.5" /> Add pack
          </Button>
          {!isCreateMode && (
            <Button type="button" size="sm" onClick={saveAll} disabled={loading}>
              Save packs
            </Button>
          )}
        </div>
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground rounded-md border border-dashed p-3">
          No packaging defined yet. Lines for this product use the base unit
          only. Add packs above to buy in cartons or sell in strips.
        </p>
      ) : (
        <div className="space-y-2">
          {rows.map((r, idx) => (
            <div
              key={r.id}
              className="grid grid-cols-12 items-end gap-2 rounded-md border p-2"
            >
              <div className="col-span-3">
                <Label className="text-xs">Name</Label>
                <Input
                  value={r.name}
                  placeholder="Carton of 24"
                  onChange={(e) => update(idx, { name: e.target.value })}
                />
              </div>
              <div className="col-span-2">
                <Label className="text-xs">Qty in base unit</Label>
                <Input
                  type="number"
                  step="0.001"
                  min="0"
                  value={r.qty_in_base_uom}
                  onChange={(e) =>
                    update(idx, { qty_in_base_uom: parseFloat(e.target.value) || 0 })
                  }
                />
              </div>
              <div className="col-span-3">
                <Label className="text-xs">Scan barcode</Label>
                {isCreateMode ? (
                  <Input
                    disabled
                    placeholder="Save product first to bind"
                    className="h-9 text-xs italic"
                  />
                ) : (
                  <Select
                    value={identifierForLevel(r.id) ?? "__none__"}
                    onValueChange={(v) =>
                      void bindIdentifierToLevel(r.id, v === "__none__" ? null : v)
                    }
                  >
                    <SelectTrigger className="h-9">
                      <SelectValue placeholder="No barcode" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">— No barcode —</SelectItem>
                      {barcodes.map((b) => (
                        <SelectItem key={b.id} value={b.id}>
                          {b.code} <span className="ml-1 text-muted-foreground">({b.kind})</span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
              <div className="col-span-1 flex items-center gap-1 pb-2">
                <Checkbox
                  checked={r.is_purchase_default}
                  onCheckedChange={(v) => update(idx, { is_purchase_default: !!v })}
                />
                <span className="text-xs">PO</span>
              </div>
              <div className="col-span-1 flex items-center gap-1 pb-2">
                <Checkbox
                  checked={r.is_sales_default}
                  onCheckedChange={(v) => update(idx, { is_sales_default: !!v })}
                />
                <span className="text-xs">Sell</span>
              </div>
              <div className="col-span-2 flex justify-end pb-1">
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  onClick={() => void removeRow(idx)}
                >
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </div>
            </div>
          ))}
          {isCreateMode && (
            <p className="text-xs text-muted-foreground">
              These packs will be saved together with the product. You can bind a
              scan barcode to each pack after the product is created.
            </p>
          )}
          {!isCreateMode && barcodes.length === 0 && (
            <p className="text-xs text-muted-foreground">
              Tip: define barcodes in the "Barcodes" section of the product form
              first — then bind a barcode here so scans resolve directly to this pack.
            </p>
          )}
        </div>
      )}
    </div>
  );
});
