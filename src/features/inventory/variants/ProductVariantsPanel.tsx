/**
 * ProductVariantsPanel — mounted inside ProductForm (edit mode only).
 *
 * Doctrine (ADR 0072): variants are ordinary `products` rows joined by
 * `variant_parent_id`. This panel:
 *   1. Marks the current product as `is_variant_parent`.
 *   2. Lets the user pick axes + values from the business catalogue.
 *   3. Generates the missing variant matrix as child product rows,
 *      copying the parent's pricing / tracking / accounts defaults.
 *   4. Lists existing variants with quick links to their edit page.
 */
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Loader2, Plus, Trash2, ExternalLink } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { Section, FieldGrid } from "@/design-system";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";

import {
  useVariantAxes,
  useCreateVariantAxis,
  useAddAxisValue,
} from "./useVariantAxes";
import {
  generateVariantMatrix,
  deriveVariantSku,
  sameCoord,
  type VariantCoordinate,
} from "./generateVariantMatrix";

interface Props {
  productId: string;
  businessId: string;
  organizationId: string;
  parentSku: string | null;
  parentDefaults: {
    unit_price?: number | null;
    cost_price?: number | null;
    tax_rate?: number | null;
    tax_rate_id?: string | null;
    category_id?: string | null;
    base_uom_id?: string | null;
    sales_uom_id?: string | null;
    purchase_uom_id?: string | null;
    is_lot_tracked?: boolean | null;
    is_serial_tracked?: boolean | null;
    is_expiry_tracked?: boolean | null;
    track_inventory?: boolean | null;
    image_url?: string | null;
    description?: string | null;
    parentName: string;
  };
  isVariantParent: boolean;
  onParentFlagChange: (next: boolean) => void;
}

export function ProductVariantsPanel({
  productId,
  businessId,
  organizationId,
  parentSku,
  parentDefaults,
  isVariantParent,
  onParentFlagChange,
}: Props) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const axesQ = useVariantAxes(businessId);
  const createAxis = useCreateVariantAxis(businessId);
  const addValue = useAddAxisValue(businessId);

  const variantsQ = useQuery({
    queryKey: ["product-variants", productId],
    enabled: !!productId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("products")
        .select("id,name,sku,unit_price,variant_axis_values,is_active")
        .eq("variant_parent_id", productId)
        .order("sku", { ascending: true });
      if (error) throw error;
      return data ?? [];
    },
  });

  const existingCoords: VariantCoordinate[] = useMemo(
    () =>
      (variantsQ.data ?? [])
        .map((v) => v.variant_axis_values as VariantCoordinate | null)
        .filter((c): c is VariantCoordinate => !!c),
    [variantsQ.data],
  );

  // Selection state: axisName -> Set of selected values
  const [selected, setSelected] = useState<Record<string, Set<string>>>({});
  const [newAxisName, setNewAxisName] = useState("");
  const [newValueDraft, setNewValueDraft] = useState<Record<string, string>>({});
  const [generating, setGenerating] = useState(false);

  useEffect(() => {
    // Auto-select coordinates already present so the user sees the current shape.
    if (!axesQ.data) return;
    setSelected((prev) => {
      if (Object.keys(prev).length > 0) return prev;
      const seed: Record<string, Set<string>> = {};
      for (const coord of existingCoords) {
        for (const [axisName, val] of Object.entries(coord)) {
          if (!seed[axisName]) seed[axisName] = new Set();
          seed[axisName].add(val);
        }
      }
      return seed;
    });
  }, [axesQ.data, existingCoords]);

  const toggle = (axisName: string, value: string) => {
    setSelected((prev) => {
      const next = { ...prev };
      const set = new Set(next[axisName] ?? []);
      if (set.has(value)) set.delete(value);
      else set.add(value);
      next[axisName] = set;
      return next;
    });
  };

  const preview = useMemo(() => {
    const selections = Object.entries(selected).map(([axisName, values]) => ({
      axisName,
      values: Array.from(values),
    }));
    return generateVariantMatrix(selections);
  }, [selected]);

  const missing = useMemo(
    () => preview.filter((c) => !existingCoords.some((e) => sameCoord(e, c))),
    [preview, existingCoords],
  );

  const handleCreateAxis = async () => {
    const name = newAxisName.trim();
    if (!name) return;
    try {
      await createAxis.mutateAsync(name);
      setNewAxisName("");
    } catch (e) {
      toast({
        title: "Could not create axis",
        description: (e as Error).message,
        variant: "destructive",
      });
    }
  };

  const handleAddValue = async (axisId: string) => {
    const draft = newValueDraft[axisId]?.trim();
    if (!draft) return;
    try {
      await addValue.mutateAsync({ axisId, value: draft });
      setNewValueDraft((p) => ({ ...p, [axisId]: "" }));
    } catch (e) {
      toast({
        title: "Could not add value",
        description: (e as Error).message,
        variant: "destructive",
      });
    }
  };

  const handleGenerate = async () => {
    if (missing.length === 0) return;
    setGenerating(true);
    try {
      // Ensure parent flag is set before children are attached.
      if (!isVariantParent) {
        const { error } = await supabase
          .from("products")
          .update({ is_variant_parent: true })
          .eq("id", productId);
        if (error) throw error;
        onParentFlagChange(true);
      }

      const rows = missing.map((coord) => ({
        organization_id: organizationId,
        business_id: businessId,
        variant_parent_id: productId,
        is_variant_parent: false,
        variant_axis_values: coord,
        name: `${parentDefaults.parentName} — ${Object.values(coord).join(" / ")}`,
        sku: deriveVariantSku(parentSku, coord),
        type: "product" as const,
        unit_price: parentDefaults.unit_price ?? 0,
        cost_price: parentDefaults.cost_price ?? 0,
        tax_rate: parentDefaults.tax_rate ?? 0,
        tax_rate_id: parentDefaults.tax_rate_id ?? null,
        category_id: parentDefaults.category_id ?? null,
        base_uom_id: parentDefaults.base_uom_id ?? null,
        sales_uom_id: parentDefaults.sales_uom_id ?? null,
        purchase_uom_id: parentDefaults.purchase_uom_id ?? null,
        is_lot_tracked: parentDefaults.is_lot_tracked ?? false,
        is_serial_tracked: parentDefaults.is_serial_tracked ?? false,
        is_expiry_tracked: parentDefaults.is_expiry_tracked ?? false,
        track_inventory: parentDefaults.track_inventory ?? true,
        image_url: parentDefaults.image_url ?? null,
        description: parentDefaults.description ?? null,
        is_active: true,
      }));

      const { error } = await supabase.from("products").insert(rows);
      if (error) throw error;

      toast({
        title: `Generated ${rows.length} variant${rows.length === 1 ? "" : "s"}`,
      });
      await qc.invalidateQueries({ queryKey: ["product-variants", productId] });
    } catch (e) {
      toast({
        title: "Variant generation failed",
        description: (e as Error).message,
        variant: "destructive",
      });
    } finally {
      setGenerating(false);
    }
  };

  return (
    <Section
      title="Variants"
      description="Manage size / colour / pack variants for this product. Each variant is a first-class SKU with its own stock, price and barcodes."
    >
      <div className="space-y-6">
        <div className="flex items-start gap-3 rounded-md border border-dashed p-3">
          <Checkbox
            id="is-variant-parent"
            checked={isVariantParent}
            onCheckedChange={(v) => onParentFlagChange(!!v)}
          />
          <div className="space-y-1">
            <Label htmlFor="is-variant-parent" className="cursor-pointer">
              This product is a variant parent
            </Label>
            <p className="text-xs text-muted-foreground">
              Parent rows are never transacted against — pickers, stock reports
              and POS ignore them. Generate the matrix below to create the
              sellable child variants.
            </p>
          </div>
        </div>

        {/* Axis catalogue */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-medium">Axes</h4>
            {axesQ.isLoading && (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            )}
          </div>

          <FieldGrid>
            <div className="flex gap-2 md:col-span-2">
              <Input
                placeholder="New axis (e.g. Size, Colour, Pack)"
                value={newAxisName}
                onChange={(e) => setNewAxisName(e.target.value)}
              />
              <Button
                type="button"
                variant="outline"
                onClick={handleCreateAxis}
                disabled={createAxis.isPending || !newAxisName.trim()}
              >
                <Plus className="mr-1 h-4 w-4" />
                Add axis
              </Button>
            </div>
          </FieldGrid>

          {(axesQ.data ?? []).map((axis) => (
            <div
              key={axis.id}
              className="rounded-md border p-3 space-y-2"
              data-testid={`variant-axis-${axis.name}`}
            >
              <div className="flex items-center justify-between">
                <div className="font-medium text-sm">{axis.name}</div>
                <Badge variant="outline">{axis.values.length} values</Badge>
              </div>
              <div className="flex flex-wrap gap-2">
                {axis.values.map((v) => {
                  const isSelected = selected[axis.name]?.has(v.value) ?? false;
                  return (
                    <button
                      key={v.id}
                      type="button"
                      onClick={() => toggle(axis.name, v.value)}
                      className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                        isSelected
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-input hover:bg-accent"
                      }`}
                    >
                      {v.value}
                    </button>
                  );
                })}
                {axis.values.length === 0 && (
                  <span className="text-xs text-muted-foreground">
                    No values yet.
                  </span>
                )}
              </div>
              <div className="flex gap-2">
                <Input
                  placeholder={`Add ${axis.name.toLowerCase()} value`}
                  value={newValueDraft[axis.id] ?? ""}
                  onChange={(e) =>
                    setNewValueDraft((p) => ({ ...p, [axis.id]: e.target.value }))
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleAddValue(axis.id);
                    }
                  }}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => handleAddValue(axis.id)}
                  disabled={
                    addValue.isPending || !(newValueDraft[axis.id] ?? "").trim()
                  }
                >
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ))}
        </div>

        {/* Matrix preview */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-medium">
              Matrix preview ({preview.length})
            </h4>
            <Button
              type="button"
              onClick={handleGenerate}
              disabled={generating || missing.length === 0}
            >
              {generating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Generate {missing.length} new variant
              {missing.length === 1 ? "" : "s"}
            </Button>
          </div>
          <div className="rounded-md border">
            {preview.length === 0 ? (
              <p className="p-3 text-xs text-muted-foreground">
                Select at least one value from each axis to preview the matrix.
              </p>
            ) : (
              <ul className="divide-y">
                {preview.map((coord, i) => {
                  const exists = existingCoords.some((e) => sameCoord(e, coord));
                  return (
                    <li
                      key={i}
                      className="flex items-center justify-between px-3 py-2 text-sm"
                    >
                      <span className="flex flex-wrap gap-1">
                        {Object.entries(coord).map(([k, v]) => (
                          <Badge key={k} variant="secondary">
                            {k}: {v}
                          </Badge>
                        ))}
                      </span>
                      <span className="font-mono text-xs text-muted-foreground">
                        {deriveVariantSku(parentSku, coord)}{" "}
                        {exists && (
                          <Badge variant="outline" className="ml-2">
                            exists
                          </Badge>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>

        {/* Existing variants */}
        <div className="space-y-2">
          <h4 className="text-sm font-medium">
            Existing variants ({variantsQ.data?.length ?? 0})
          </h4>
          {variantsQ.isLoading ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          ) : (variantsQ.data?.length ?? 0) === 0 ? (
            <p className="text-xs text-muted-foreground">
              No variants yet. Generate the matrix above.
            </p>
          ) : (
            <ul className="divide-y rounded-md border">
              {variantsQ.data!.map((v) => (
                <li
                  key={v.id}
                  className="flex items-center justify-between px-3 py-2 text-sm"
                >
                  <div className="flex flex-col">
                    <span>{v.name}</span>
                    <span className="font-mono text-xs text-muted-foreground">
                      {v.sku}
                    </span>
                  </div>
                  <Link
                    to={`/inventory-app/products/${v.id}/edit`}
                    className="flex items-center gap-1 text-xs text-primary hover:underline"
                  >
                    Edit <ExternalLink className="h-3 w-3" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Section>
  );
}
