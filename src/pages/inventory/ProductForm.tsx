/**
 * ProductForm — routed create/edit surface for a Product / Service.
 *
 * Replaces the legacy inline `<Dialog>` in `src/pages/Products.tsx`. Same
 * behavior (opening-stock atomic RPC, scanner onboarding prefill) but hosted
 * on `/inventory-app/products/new`
 * and `/inventory-app/products/:id/edit` inside `RecordFormShell` — the
 * enterprise UX standard.
 *
 * Save is ONE transaction: `saveProductAtomic` sends the master row together
 * with packaging levels, measurements and identifiers, so a failure in any
 * child can never leave a half-built product behind (the old "product created
 * — packaging save failed" toast). Opening stock keeps its own dedicated RPC
 * because it posts to the general ledger and may require approval.
 */
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Loader2, DollarSign, FileCheck2, ChevronDown } from "lucide-react";

import {
  RecordFormShell,
  Section,
  FieldGrid,
  FieldCell,
} from "@/design-system";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ToastAction } from "@/components/ui/toast";

import { useToast } from "@/hooks/use-toast";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useIndustryProfile } from "@/hooks/useIndustryProfile";
import { useWarehouses } from "@/hooks/useWarehouses";
import { useTaxRates } from "@/hooks/useTaxRates";
import { useTaxCompliance } from "@/hooks/useTaxCompliance";
import { useProducts, type Product } from "@/hooks/useProducts";
import { useProductUomLock } from "@/hooks/inventory/useProductUomLock";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { normalizeError } from "@/services/resilience";
import { saveProductAtomic } from "@/features/products/save/saveProductAtomic";
import { useProductTaxLocalization } from "@/features/products/localization/productTaxLocalization";


import { ProductImageUpload } from "@/components/products/ProductImageUpload";
import { ProductCategorySelector } from "@/components/products/ProductCategorySelector";
import { ProductAccountSelector } from "@/components/products/ProductAccountSelector";
import { useProductCategories } from "@/hooks/useProductCategories";
import { resolveCategoryAccount, type CategoryAccountField } from "@/lib/productCategoryAccounts";
import { ProductStockPanel } from "@/components/products/ProductStockPanel";
import { UomSelect } from "@/components/products/UomSelect";
import {
  ProductIdentifiersEditor,
  type ProductIdentifiersEditorHandle,
} from "@/components/products/ProductIdentifiersEditor";
import {
  ProductPackagingEditor,
  type ProductPackagingEditorHandle,
} from "@/components/products/ProductPackagingEditor";
import {
  ProductPhysicalAttributesEditor,
  type ProductPhysicalAttributesEditorHandle,
} from "@/components/products/ProductPhysicalAttributesEditor";

import { CustomFieldsSection } from "@/components/studio/CustomFieldsSection";
import { ProductVariantsPanel } from "@/features/inventory/variants/ProductVariantsPanel";
import {
  EtimsUnitCodeSelect,
  EtimsPackagingCodeSelect,
  EtimsClassificationCodeSelect,
  EtimsCountryOriginSelect,
} from "@/components/etims/EtimsCodeSelectors";
import { PurchasingDefaultsSection } from "./product-form/sections/PurchasingDefaultsSection";

interface ProductFormProps {
  mode: "create" | "edit";
  product?: Product | null;
  /** Prefills the first identifier row on create (POS unknown-barcode recovery). */
  initialBarcode?: string;
}

export function ProductForm({ mode, product, initialBarcode }: ProductFormProps) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { industry: businessIndustry, profile: industryProfile } = useIndustryProfile();
  const { activeWarehouses } = useWarehouses();
  const { taxRates } = useTaxRates();
  const { isComplianceAvailable, complianceInfo } = useTaxCompliance();
  const queryClient = useQueryClient();

  const identifiersRef = useRef<ProductIdentifiersEditorHandle | null>(null);
  const packagingRef = useRef<ProductPackagingEditorHandle | null>(null);
  const physicalRef = useRef<ProductPhysicalAttributesEditorHandle | null>(null);


  const editing = mode === "edit" ? product ?? null : null;

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showAdvancedUoM, setShowAdvancedUoM] = useState(false);
  const [openingByWarehouse, setOpeningByWarehouse] = useState<Record<string, number>>({});
  const [openingCostByWarehouse, setOpeningCostByWarehouse] = useState<Record<string, number>>({});

  const { data: uomLock } = useProductUomLock(editing?.id ?? null);
  const baseUomLocked = !!uomLock?.locked;

  const [formData, setFormData] = useState({
    name: "",
    description: "",
    type: "service" as "product" | "service",
    sku: "",
    unit_price: 0,
    cost_price: 0,
    tax_rate: 0,
    image_url: null as string | null,
    track_inventory: false,
    stock_quantity: 0,
    reorder_level: 0,
    reorder_quantity: 0,
    min_order_quantity: 1,
    order_quantity_increment: 1,
    category_id: null as string | null,
    sales_account_id: null as string | null,
    purchase_account_id: null as string | null,
    cogs_account_id: null as string | null,
    inventory_account_id: null as string | null,
    tax_rate_id: null as string | null,
    base_uom_id: null as string | null,
    sales_uom_id: null as string | null,
    purchase_uom_id: null as string | null,
    is_lot_tracked: industryProfile.defaultLotTracking,
    is_expiry_tracked: industryProfile.defaultExpiryTracking,
    expiry_alert_days: 30,
  });

  // Fiscal metadata is NOT product master data — it lives per jurisdiction in
  // `product_tax_localization`. Kept in its own state so the product payload
  // never carries one country's tax vocabulary.
  const [localization, setLocalization] = useState({
    classification_code: "",
    unit_code: "U",
    packaging_unit: "CT",
    origin_country: currentBusiness?.country || "",
  });


  // Category tier of the GL ladder (ADR 0122): product → category (walking
  // parents) → company default. Presentation only; posting uses the same
  // helper in src/lib/resolveProductAccounts.ts.
  const { categories: productCategories } = useProductCategories();
  const categoryAccount = (field: CategoryAccountField) =>
    resolveCategoryAccount(productCategories, formData.category_id, field);

  // Seed defaults for create-mode when business/industry resolve after mount.
  useEffect(() => {
    if (mode !== "create") return;
    setFormData((f) => ({
      ...f,
      is_lot_tracked: f.is_lot_tracked || industryProfile.defaultLotTracking,
      is_expiry_tracked: f.is_expiry_tracked || industryProfile.defaultExpiryTracking,
    }));
    setLocalization((l) => ({
      ...l,
      origin_country: l.origin_country || currentBusiness?.country || "",
    }));
  }, [mode, currentBusiness?.country, industryProfile.defaultLotTracking, industryProfile.defaultExpiryTracking]);

  // Fiscal metadata hydrates from `product_tax_localization`, not from the
  // product row — those columns no longer exist on `products`.
  const { data: existingLocalization } = useProductTaxLocalization(
    mode === "edit" ? editing?.id : null,
  );

  useEffect(() => {
    if (mode !== "edit") return;
    setLocalization({
      classification_code: existingLocalization?.classification_code || "",
      unit_code: existingLocalization?.unit_code || "U",
      packaging_unit: existingLocalization?.packaging_unit || "CT",
      origin_country:
        existingLocalization?.origin_country || currentBusiness?.country || "",
    });
  }, [mode, existingLocalization, currentBusiness?.country]);

  // Hydrate from existing product on edit.
  useEffect(() => {
    if (mode !== "edit" || !editing) return;
    setFormData({
      name: editing.name,
      description: editing.description || "",
      type: editing.type,
      sku: editing.sku || "",
      unit_price: editing.unit_price,
      cost_price: editing.cost_price || 0,
      tax_rate: editing.tax_rate || 0,
      image_url: editing.image_url,
      track_inventory: (editing as any).track_inventory || false,
      stock_quantity: (editing as any).stock_quantity || 0,
      reorder_level: (editing as any).reorder_level || 0,
      reorder_quantity: (editing as any).reorder_quantity || 0,
      min_order_quantity: editing.min_order_quantity || 1,
      order_quantity_increment: editing.order_quantity_increment || 1,
      category_id: (editing as any).category_id || null,
      sales_account_id: editing.sales_account_id || null,
      purchase_account_id: (editing as any).purchase_account_id || null,
      cogs_account_id: editing.cogs_account_id || null,
      inventory_account_id: editing.inventory_account_id || null,
      tax_rate_id: (editing as any).tax_rate_id || null,
      base_uom_id: (editing as any).base_uom_id || null,
      sales_uom_id: (editing as any).sales_uom_id || null,
      purchase_uom_id: (editing as any).purchase_uom_id || null,
      is_lot_tracked: !!(editing as any).is_lot_tracked,
      is_expiry_tracked: !!(editing as any).is_expiry_tracked,
      expiry_alert_days: (editing as any).expiry_alert_days ?? 30,
    });
  }, [mode, editing, currentBusiness?.country]);


  const backHref = "/inventory-app/products";

  const goBackToList = (selectedId?: string) => {
    if (selectedId) {
      navigate(`${backHref}?selected=${selectedId}`);
    } else {
      navigate(backHref);
    }
  };

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setIsSubmitting(true);

    try {
      // One payload for the whole product: master + packaging + measurements
      // + identifiers + fiscal localization. The database writes all of it or
      // none of it. The jurisdiction is resolved server-side from the business.
      const children = {
        packaging: packagingRef.current?.collect() ?? [],
        physical: physicalRef.current?.collect() ?? [],
        identifiers: identifiersRef.current?.collect() ?? [],
        localization: {
          classification_code: localization.classification_code || null,
          unit_code: localization.unit_code || null,
          packaging_unit: localization.packaging_unit || null,
          origin_country: localization.origin_country || null,
        },
      };


      if (editing) {
        const { productId } = await saveProductAtomic({
          product: formData,
          productId: editing.id,
          ...children,
        });
        toast({ title: "Product updated successfully" });
        queryClient.invalidateQueries({ queryKey: ["products-paginated"] });
        goBackToList(productId);
        return;
      }

      // Create path — opening stock keeps its own atomic RPC because it posts
      // to the general ledger and may require approval.
      const openingItems = Object.entries(openingByWarehouse)
        .filter(([, qty]) => Number(qty) > 0)
        .map(([warehouse_id, qty]) => {
          const perWarehouseCost = Number(openingCostByWarehouse[warehouse_id]);
          const fallbackCost = Number(formData.cost_price) || 0;
          const unitCost = perWarehouseCost > 0 ? perWarehouseCost : fallbackCost;
          return { warehouse_id, quantity_adjustment: Number(qty), unit_cost: unitCost };
        });

      const useAtomic =
        formData.track_inventory && openingItems.length > 0 && !!currentOrg && !!currentBusiness;

      if (useAtomic) {
        const invalid = openingItems.find((it) => !(Number(it.unit_cost) > 0));
        if (invalid) {
          const wh = activeWarehouses.find((w) => w.id === invalid.warehouse_id);
          throw new Error(
            `Opening stock for ${wh?.name ?? "warehouse"} needs a positive unit cost. ` +
              `Enter the product cost or a per-warehouse unit cost.`,
          );
        }
      }

      let createdId: string;

      if (useAtomic) {
        const { data: userData } = await supabase.auth.getUser();
        const userId = userData?.user?.id;
        if (!userId) throw new Error("Not authenticated");

        const { data, error } = await supabase.rpc(
          "create_product_with_opening_stock_atomic" as any,
          {
            p_product: {
              ...formData,
              organization_id: currentOrg!.id,
              business_id: currentBusiness!.id,
              is_active: true,
            },
            p_opening_items: openingItems,
            p_user_id: userId,
          } as any,
        );
        if (error) {
          const msg = String((error as any)?.message ?? error);
          const code = String((error as any)?.code ?? "");
          if (
            code === "PGRST202" ||
            code === "PGRST203" ||
            msg.includes("Could not find the function")
          ) {
            throw new Error(
              "Inventory RPC is out of sync (create_product_with_opening_stock_atomic). " +
                "Please reload the page. If the problem persists, contact support — " +
                "do not bypass opening stock, it would break the general ledger.",
            );
          }
          if (msg.includes("OPENING_STOCK_REQUIRES_COST")) {
            throw new Error(
              "Opening stock requires a positive unit cost on every warehouse line. " +
                "Set the product cost or enter a per-warehouse unit cost.",
            );
          }
          throw error;
        }

        const result = data as any;
        if (!result?.success || !result?.product_id) {
          throw new Error(result?.error || "Failed to create product with opening stock");
        }
        createdId = result.product_id as string;

        // Children in a second transaction — the product row already exists
        // and carries ledger postings, so it must not be rolled back here.
        await saveProductAtomic({ product: formData, productId: createdId, ...children });

        const requiresApproval = result.opening_stock?.requires_approval === true;
        const journalEntryId =
          result.opening_stock?.journal_entry_id ??
          result.opening_stock?.adjustments?.[0]?.result?.journal_entry_id ??
          null;
        toast({
          title: requiresApproval
            ? "Product saved — opening stock submitted for approval"
            : "Opening stock recorded",
          description: journalEntryId
            ? `Posted to general ledger (JE ${String(journalEntryId).slice(0, 8)}…)`
            : undefined,
          action: journalEntryId ? (
            <ToastAction
              altText="View journal entry"
              onClick={() =>
                navigate(`/finance/journal-entries?selected=${String(journalEntryId)}`)
              }
            >
              View entry
            </ToastAction>
          ) : undefined,
        });

        queryClient.invalidateQueries({ queryKey: ["stock-adjustments"] });
        queryClient.invalidateQueries({ queryKey: ["stock-movements"] });
        queryClient.invalidateQueries({ queryKey: ["warehouse-stock-totals"] });
        queryClient.invalidateQueries({ queryKey: ["products-list-stock"] });
        queryClient.invalidateQueries({ queryKey: ["products-paginated"] });
        queryClient.invalidateQueries({ queryKey: ["journal-entries"] });
      } else {
        const { productId } = await saveProductAtomic({
          product: {
            ...formData,
            organization_id: currentOrg?.id ?? null,
            business_id: currentBusiness?.id ?? null,
            is_active: true,
          },
          ...children,
        });
        createdId = productId;
        toast({ title: "Product created successfully" });
      }

      queryClient.invalidateQueries({ queryKey: ["products-paginated"] });
      goBackToList(createdId);
    } catch (error: any) {
      toast({
        title: "Error",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <RecordFormShell
      mode={mode}
      entityLabel="Product"
      recordRef={editing?.name}
      cancelHref={backHref}
      onSubmit={handleSubmit}
      isSubmitting={isSubmitting}
      submitDisabled={!formData.name}
      submitLabel={editing ? "Save changes" : "Add item"}
    >
      {/* Image */}
      {currentOrg && (
        <Section title="Image" description="Optional product photo.">
          <ProductImageUpload
            currentImageUrl={formData.image_url}
            onImageChange={(url) => setFormData({ ...formData, image_url: url })}
            organizationId={currentOrg.id}
            productId={editing?.id}
          />
        </Section>
      )}

      {/* Identity */}
      <IdentitySection values={formData} onChange={patch} disabled={isSubmitting} />


      {/* Identifiers */}
      {currentOrg && currentBusiness && (
        <Section title="Identifiers" description="Barcodes, GTINs, supplier codes.">
          <ProductIdentifiersEditor
            ref={identifiersRef}
            productId={editing?.id ?? null}
            organizationId={currentOrg.id}
            businessId={currentBusiness.id}
            initialBarcode={!editing ? initialBarcode : undefined}
          />
        </Section>
      )}

      {/* Packaging */}
      {formData.type === "product" && currentOrg && currentBusiness && (
        <Section title="Packaging" description="Cartons, strips, packs above the inventory unit.">
          <ProductPackagingEditor
            ref={packagingRef}
            productId={editing?.id ?? null}
            organizationId={currentOrg.id}
            businessId={currentBusiness.id}
          />
        </Section>
      )}

      {/* Physical attributes — canonical weight / volume / dimensions */}
      {formData.type === "product" && currentOrg && currentBusiness && (
        <Section
          title="Physical attributes"
          description="Weight, volume and dimensions used by freight, landed cost, shipping and warehouse capacity."
        >
          <ProductPhysicalAttributesEditor
            ref={physicalRef}
            productId={editing?.id ?? null}
            organizationId={currentOrg.id}
            businessId={currentBusiness.id}
          />
        </Section>
      )}



      {/* Inventory unit */}
      {formData.type === "product" && (
        <Section
          title="Inventory unit"
          description="The unit stock and cost are stored in."
        >
          <div className="space-y-3">
            <div className="space-y-2">
              <Label>Inventory unit *</Label>
              <UomSelect
                value={formData.base_uom_id}
                disabled={baseUomLocked}
                onChange={(id) =>
                  setFormData({
                    ...formData,
                    base_uom_id: id,
                    sales_uom_id: id,
                    purchase_uom_id: id,
                  })
                }
                placeholder="Pick the unit you count this product in…"
              />
              {baseUomLocked ? (
                <div className="rounded-md border border-amber-500/40 bg-amber-50 dark:bg-amber-950/30 p-2 text-xs space-y-1">
                  <p className="font-medium text-amber-900 dark:text-amber-200">
                    Inventory unit is locked
                  </p>
                  <p className="text-amber-800 dark:text-amber-300">
                    {uomLock?.reason} Changing the inventory unit after the product has
                    been transacted would silently rescale stock value and history. To
                    buy or sell in a different unit (e.g. grams against a KG base), add
                    a <strong>Packaging</strong> entry above with the right multiplier.
                  </p>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Stock and cost are stored in this unit. Add packs above to buy or
                  sell in cartons, strips, etc.
                </p>
              )}
            </div>
            <Collapsible open={showAdvancedUoM} onOpenChange={setShowAdvancedUoM}>
              <CollapsibleTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 px-2 text-xs text-muted-foreground"
                >
                  <ChevronDown
                    className={`mr-1 h-3.5 w-3.5 transition-transform ${
                      showAdvancedUoM ? "rotate-180" : ""
                    }`}
                  />
                  Advanced: different sales / purchase unit
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="pt-2">
                <FieldGrid columns={2}>
                  <div className="space-y-2">
                    <Label>Sales unit</Label>
                    <UomSelect
                      value={formData.sales_uom_id}
                      onChange={(id) => setFormData({ ...formData, sales_uom_id: id })}
                      placeholder="Defaults to inventory unit"
                      allowClear
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Purchase unit</Label>
                    <UomSelect
                      value={formData.purchase_uom_id}
                      onChange={(id) => setFormData({ ...formData, purchase_uom_id: id })}
                      placeholder="Defaults to inventory unit"
                      allowClear
                    />
                  </div>
                </FieldGrid>
                <p className="text-xs text-muted-foreground pt-2">
                  Most products sell and buy in the same unit. Only set these when
                  sales/purchase use a different UoM category.
                </p>
              </CollapsibleContent>
            </Collapsible>
          </div>
        </Section>
      )}

      {/* Lot / expiry */}
      {formData.type === "product" && formData.track_inventory && (
        <Section
          title="Lot & expiry tracking"
          description="FEFO allocation and expiry dashboard."
        >
          <div className="space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <Label className="text-sm font-medium">Track lot / batch numbers</Label>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Each receipt records a lot number. Sales, deliveries and POS
                  auto-pick lots first-expiry-first-out (FEFO), or you can override at
                  checkout.
                </p>
                {!editing && businessIndustry && industryProfile.defaultLotTracking && (
                  <p className="text-[11px] text-primary mt-1">
                    Pre-enabled for your industry — toggle off if not needed.
                  </p>
                )}
              </div>
              <Switch
                checked={formData.is_lot_tracked}
                onCheckedChange={(v) =>
                  setFormData({
                    ...formData,
                    is_lot_tracked: v,
                    is_expiry_tracked: v ? formData.is_expiry_tracked : false,
                  })
                }
              />
            </div>
            {formData.is_lot_tracked && (
              <>
                <div className="flex items-start justify-between gap-3 border-t pt-3">
                  <div>
                    <Label className="text-sm font-medium">Track expiry dates</Label>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Surfaces lots in the "Lots expiring soon" dashboard widget once
                      they enter the alert window.
                    </p>
                  </div>
                  <Switch
                    checked={formData.is_expiry_tracked}
                    onCheckedChange={(v) =>
                      setFormData({ ...formData, is_expiry_tracked: v })
                    }
                  />
                </div>
                {formData.is_expiry_tracked && (
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3 border-t pt-3">
                    <div className="space-y-1 md:col-span-1">
                      <Label htmlFor="expiry_alert_days">Alert window (days)</Label>
                      <Input
                        id="expiry_alert_days"
                        type="number"
                        min={1}
                        max={365}
                        value={formData.expiry_alert_days}
                        onChange={(e) =>
                          setFormData({
                            ...formData,
                            expiry_alert_days: Math.max(
                              1,
                              parseInt(e.target.value, 10) || 30,
                            ),
                          })
                        }
                      />
                    </div>
                    <p className="text-xs text-muted-foreground md:col-span-2 self-end">
                      Lots within this many days of expiry appear on the inventory
                      dashboard. Defaults to 30.
                    </p>
                  </div>
                )}
              </>
            )}
          </div>
        </Section>
      )}

      {/* Pricing */}
      <Section title="Pricing" description="What you sell it for.">
        <FieldGrid columns={3}>
          <div className="space-y-2">
            <Label htmlFor="unit_price">Price *</Label>
            <Input
              id="unit_price"
              type="number"
              step="0.01"
              min="0"
              value={formData.unit_price}
              onChange={(e) =>
                setFormData({ ...formData, unit_price: parseFloat(e.target.value) || 0 })
              }
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="cost_price">Cost</Label>
            <Input
              id="cost_price"
              type="number"
              step="0.01"
              min="0"
              value={formData.cost_price}
              onChange={(e) =>
                setFormData({ ...formData, cost_price: parseFloat(e.target.value) || 0 })
              }
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="tax_rate">Tax rate</Label>
            <Select
              value={formData.tax_rate_id || "custom"}
              onValueChange={(v) => {
                if (v === "custom") {
                  setFormData({ ...formData, tax_rate_id: null });
                } else if (v === "none") {
                  setFormData({ ...formData, tax_rate_id: null, tax_rate: 0 });
                } else {
                  const selectedRate = taxRates.find((t) => t.id === v);
                  setFormData({
                    ...formData,
                    tax_rate_id: v,
                    tax_rate: selectedRate?.rate || 0,
                  });
                }
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select tax rate" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No tax (0%)</SelectItem>
                {taxRates
                  .filter((t) => t.is_active)
                  .map((rate) => (
                    <SelectItem key={rate.id} value={rate.id}>
                      <div className="flex items-center gap-2">
                        <span>
                          {rate.name} ({rate.rate}%)
                        </span>
                        {rate.etims_tax_code && (
                          <span className="text-xs text-muted-foreground font-mono">
                            [{rate.etims_tax_code}]
                          </span>
                        )}
                      </div>
                    </SelectItem>
                  ))}
                <SelectItem value="custom">Custom rate...</SelectItem>
              </SelectContent>
            </Select>
            {!formData.tax_rate_id && (
              <div className="flex gap-2 items-center mt-2">
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  max="100"
                  placeholder="Enter rate %"
                  value={formData.tax_rate}
                  onChange={(e) =>
                    setFormData({ ...formData, tax_rate: parseFloat(e.target.value) || 0 })
                  }
                  className="w-24"
                />
                <span className="text-sm text-muted-foreground">%</span>
              </div>
            )}
          </div>
        </FieldGrid>
      </Section>

      {/* Inventory tracking + opening stock */}
      {formData.type === "product" && (
        <Section title="Inventory tracking" description="Stock and reorder policy.">
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <Label htmlFor="track_inventory" className="text-base font-medium">
                  Track inventory
                </Label>
                <p className="text-sm text-muted-foreground">
                  Enable stock tracking for this product.
                </p>
              </div>
              <Switch
                id="track_inventory"
                checked={formData.track_inventory}
                onCheckedChange={(checked) =>
                  setFormData({ ...formData, track_inventory: checked })
                }
              />
            </div>

            {formData.track_inventory && (
              <>
                {editing ? (
                  <ProductStockPanel
                    productId={editing.id}
                    productName={formData.name}
                    costPrice={Number(formData.cost_price) || 0}
                    unitPrice={Number(formData.unit_price) || 0}
                  />
                ) : (
                  <div className="rounded-md border bg-muted/20 p-4 space-y-2">
                    <Label className="text-sm font-semibold">Stock</Label>
                    <p className="text-xs text-muted-foreground">
                      Stock totals derive from movements (receipts, sales, transfers,
                      adjustments) so valuation and the GL stay in sync. Use the{" "}
                      <strong>Opening stock per warehouse</strong> block below to seed
                      initial quantities — they post as a stock adjustment with{" "}
                      <code className="mx-1 text-[10px]">reason: opening_balance</code>
                      after the product is saved.
                    </p>
                  </div>
                )}

                {!editing && activeWarehouses.length > 0 && (
                  <div className="space-y-2 rounded-md border border-dashed p-3">
                    <div className="flex items-center justify-between">
                      <Label className="text-sm font-medium">
                        Opening stock per warehouse
                      </Label>
                      <span className="text-xs text-muted-foreground">Optional</span>
                    </div>
                    <div className="grid gap-2">
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span className="flex-1">Warehouse</span>
                        <span className="w-28 text-right">Quantity</span>
                        <span className="w-28 text-right">Unit cost</span>
                      </div>
                      {activeWarehouses.map((wh) => {
                        const qty = openingByWarehouse[wh.id] ?? 0;
                        const showCostError =
                          Number(qty) > 0 &&
                          !(
                            Number(openingCostByWarehouse[wh.id]) > 0 ||
                            Number(formData.cost_price) > 0
                          );
                        return (
                          <div key={wh.id} className="flex items-start gap-2">
                            <span className="flex-1 text-sm pt-2">
                              {wh.name}{" "}
                              <span className="text-muted-foreground">({wh.code})</span>
                            </span>
                            <Input
                              type="number"
                              min="0"
                              step="any"
                              placeholder="0"
                              className="w-28"
                              value={openingByWarehouse[wh.id] ?? ""}
                              onChange={(e) =>
                                setOpeningByWarehouse((prev) => ({
                                  ...prev,
                                  [wh.id]: parseFloat(e.target.value) || 0,
                                }))
                              }
                            />
                            <div className="w-28">
                              <Input
                                type="number"
                                min="0"
                                step="any"
                                placeholder={String(formData.cost_price || 0)}
                                aria-invalid={showCostError}
                                className={
                                  showCostError ? "w-28 border-destructive" : "w-28"
                                }
                                value={openingCostByWarehouse[wh.id] ?? ""}
                                onChange={(e) =>
                                  setOpeningCostByWarehouse((prev) => ({
                                    ...prev,
                                    [wh.id]: parseFloat(e.target.value) || 0,
                                  }))
                                }
                              />
                              {showCostError && (
                                <p className="text-[10px] text-destructive mt-0.5">
                                  Required &gt; 0
                                </p>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    {(() => {
                      const openingTotal = activeWarehouses.reduce((sum, wh) => {
                        const qty = Number(openingByWarehouse[wh.id] ?? 0);
                        if (!(qty > 0)) return sum;
                        const unitCost =
                          Number(openingCostByWarehouse[wh.id]) > 0
                            ? Number(openingCostByWarehouse[wh.id])
                            : Number(formData.cost_price) || 0;
                        return sum + qty * unitCost;
                      }, 0);
                      if (!(openingTotal > 0)) return null;
                      const fmt = openingTotal.toLocaleString(undefined, {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      });
                      return (
                        <div className="rounded-md bg-muted/50 border p-2 text-xs space-y-1">
                          <p className="font-medium">This will post a journal entry:</p>
                          <p className="font-mono">
                            Dr Inventory {fmt} &nbsp;/&nbsp; Cr Opening Balance Equity {fmt}
                          </p>
                          <p className="text-muted-foreground">
                            Valued at cost. Creating the product with no opening
                            quantity posts nothing to the general ledger.
                          </p>
                        </div>
                      );
                    })()}
                  </div>
                )}

                <FieldGrid columns={2}>
                  <div className="space-y-2">
                    <Label htmlFor="reorder_level">Reorder level</Label>
                    <Input
                      id="reorder_level"
                      type="number"
                      min="0"
                      value={formData.reorder_level}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          reorder_level: parseInt(e.target.value) || 0,
                        })
                      }
                    />
                    <p className="text-xs text-muted-foreground">
                      Alert when stock falls below this level.
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="reorder_quantity">Reorder quantity</Label>
                    <Input
                      id="reorder_quantity"
                      type="number"
                      min="0"
                      value={formData.reorder_quantity}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          reorder_quantity: parseInt(e.target.value) || 0,
                        })
                      }
                    />
                    <p className="text-xs text-muted-foreground">
                      Suggested quantity to reorder.
                    </p>
                  </div>
                </FieldGrid>
              </>
            )}
          </div>
        </Section>
      )}

      {/* Fallback purchasing defaults — supplier terms take precedence (ADR 0141) */}
      {formData.type === "product" && (
        <PurchasingDefaultsSection
          minOrderQuantity={formData.min_order_quantity}
          orderQuantityIncrement={formData.order_quantity_increment}
          disabled={isSubmitting}
          onChange={(patch) => setFormData({ ...formData, ...patch })}
        />
      )}


      {/* Accounting defaults */}
      {formData.type === "product" && (
        <Section
          title={
            <span className="flex items-center gap-2">
              <DollarSign className="h-4 w-4 text-muted-foreground" /> Default GL accounts
            </span>
          }
          description="Optional per-product overrides. System defaults are used when blank."
        >
          <FieldGrid columns={2}>
            <ProductAccountSelector
              label="Sales revenue account"
              value={formData.sales_account_id}
              onChange={(v) => setFormData({ ...formData, sales_account_id: v })}
              accountType="income"
              defaultKey="sales_revenue_id"
              categoryDefault={categoryAccount("sales_account_id")}
              helpText="Revenue account credited on sale"
              disabled={isSubmitting}
            />
            <ProductAccountSelector
              label="Purchase / expense account"
              value={formData.purchase_account_id}
              onChange={(v) => setFormData({ ...formData, purchase_account_id: v })}
              accountType="expense"
              defaultKey="operating_expenses_id"
              categoryDefault={categoryAccount("purchase_account_id")}
              helpText="Expense account debited when this item appears on a bill"
              disabled={isSubmitting}
            />
            {(formData.type === "product" || formData.track_inventory) && (
              <>
                <ProductAccountSelector
                  label="COGS account"
                  value={formData.cogs_account_id}
                  onChange={(v) => setFormData({ ...formData, cogs_account_id: v })}
                  accountType="expense"
                  defaultKey="cost_of_goods_sold_id"
                  categoryDefault={categoryAccount("cogs_account_id")}
                  helpText="Cost of Goods Sold debited on sale"
                  disabled={isSubmitting}
                />
                <ProductAccountSelector
                  label="Inventory account"
                  value={formData.inventory_account_id}
                  onChange={(v) => setFormData({ ...formData, inventory_account_id: v })}
                  accountType="asset"
                  defaultKey="inventory_account_id"
                  categoryDefault={categoryAccount("inventory_account_id")}
                  helpText="Inventory asset account for stock valuation"
                  disabled={isSubmitting}
                />
              </>
            )}
          </FieldGrid>
        </Section>
      )}

      {/* Tax compliance */}
      {isComplianceAvailable && formData.type === "product" && (
        <Section
          title={
            <span className="flex items-center gap-2">
              <FileCheck2 className="h-4 w-4 text-muted-foreground" /> Tax compliance —{" "}
              {complianceInfo?.displayName}
            </span>
          }
          description="Codes transmitted with invoices and receipts for fiscal reporting."
        >
          <FieldGrid columns={2}>
            <div className="space-y-2">
              <Label>Tax rate (with compliance code)</Label>
              <Select
                value={formData.tax_rate_id || "none"}
                onValueChange={(v) => {
                  const selectedRate = taxRates.find((t) => t.id === v);
                  setFormData({
                    ...formData,
                    tax_rate_id: v === "none" ? null : v,
                    tax_rate: selectedRate?.rate || 0,
                  });
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select tax rate" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No tax</SelectItem>
                  {taxRates
                    .filter((t) => t.is_active)
                    .map((rate) => (
                      <SelectItem key={rate.id} value={rate.id}>
                        <div className="flex items-center gap-2">
                          <span>
                            {rate.name} ({rate.rate}%)
                          </span>
                          {rate.etims_tax_code && (
                            <Badge variant="outline" className="font-mono text-xs">
                              {rate.etims_tax_code}
                            </Badge>
                          )}
                        </div>
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <EtimsClassificationCodeSelect
              value={localization.classification_code}
              onChange={(v) =>
                setLocalization({ ...localization, classification_code: v })
              }
            />
            <EtimsUnitCodeSelect
              value={localization.unit_code}
              onChange={(v) => setLocalization({ ...localization, unit_code: v })}
            />
            <EtimsPackagingCodeSelect
              value={localization.packaging_unit}
              onChange={(v) => setLocalization({ ...localization, packaging_unit: v })}
            />
            <EtimsCountryOriginSelect
              value={localization.origin_country}
              onChange={(v) => setLocalization({ ...localization, origin_country: v })}
            />

          </FieldGrid>
        </Section>
      )}

      {/* Variants (edit mode only — parent must exist before children can be attached) */}
      {editing?.id && currentBusiness?.id && currentOrg?.id && (
        <ProductVariantsPanel
          productId={editing.id}
          businessId={currentBusiness.id}
          organizationId={currentOrg.id}
          parentSku={formData.sku || null}
          isVariantParent={!!(editing as any).is_variant_parent}
          onParentFlagChange={(next) => {
            // Local state is intentionally not tracked here — the panel writes
            // the flag directly to the DB before inserting children. Refresh
            // the products cache so the flag propagates.
            queryClient.invalidateQueries({ queryKey: ["products"] });
            void next;
          }}
          parentDefaults={{
            unit_price: formData.unit_price,
            cost_price: formData.cost_price,
            tax_rate: formData.tax_rate,
            tax_rate_id: (formData as any).tax_rate_id ?? null,
            category_id: (formData as any).category_id ?? null,
            base_uom_id: (formData as any).base_uom_id ?? null,
            sales_uom_id: (formData as any).sales_uom_id ?? null,
            purchase_uom_id: (formData as any).purchase_uom_id ?? null,
            is_lot_tracked: (formData as any).is_lot_tracked ?? false,
            is_serial_tracked: (formData as any).is_serial_tracked ?? false,
            is_expiry_tracked: (formData as any).is_expiry_tracked ?? false,
            track_inventory: formData.track_inventory,
            image_url: formData.image_url,
            description: formData.description,
            parentName: formData.name,
          }}
        />
      )}

      {/* Custom fields */}
      <Section title="Custom fields" description="Studio-defined extensions.">
        <CustomFieldsSection
          entityType="product"
          entityId={editing?.id || null}
          formValues={formData}
          disabled={isSubmitting}
        />
      </Section>
    </RecordFormShell>
  );
}

export default ProductForm;
