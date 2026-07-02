import { useState, useMemo, useRef, useEffect } from "react";
import { useSearchParams, Link, useNavigate } from "react-router-dom";
import { ConfirmDeleteDialog, useConfirmDelete } from "@/components/shared/ConfirmDeleteDialog";
import { useProductsPaginated } from "@/hooks/useProductsPaginated";
import { Product } from "@/hooks/useProducts";
import { useProductUomLock } from "@/hooks/inventory/useProductUomLock";
import { useCurrency } from "@/hooks/useCurrency";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useIndustryProfile } from "@/hooks/useIndustryProfile";
import { usePermissions } from "@/hooks/usePermissions";
import { useViewMode } from "@/hooks/useViewMode";
import { useListViewColumns, DefaultColumn } from "@/hooks/useListViewColumns";
import { useCoreFieldDisplay } from "@/hooks/useCoreFieldDisplay";
import { useTaxRates } from "@/hooks/useTaxRates";
import { useProductCategories } from "@/hooks/useProductCategories";
import { ImportWizard } from "@/components/common/ImportWizard";
import { FieldDefinition } from "@/lib/importUtils";
import { PRODUCT_IMPORT_FIELDS, normalizeProductType } from "@/lib/importConfigs/productImportConfig";
import { CategoryResolver } from "@/lib/categoryResolver";
import { ViewSwitcher } from "@/components/common/ViewSwitcher";
import { DynamicViewsRenderer } from "@/components/common/DynamicViewsRenderer";
import { CustomFieldFilters } from "@/components/common/CustomFieldFilters";
import { useCustomFieldFiltering } from "@/hooks/useCustomFieldFiltering";
import { StudioQuickPanelTrigger } from "@/components/studio/StudioQuickPanelTrigger";
import { Button } from "@/components/ui/button";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { ToastAction } from "@/components/ui/toast";
import { StockCell } from "@/components/products/StockCell";
import { ProductBadgeStrip } from "@/components/products/ProductBadgeStrip";
import { useProductPackagingBatch } from "@/hooks/inventory/useProductPackagingBatch";
import {
  Plus,
  Search,
  Package,
  MoreHorizontal,
  Loader2,
  Pencil,
  Trash2,
  Briefcase,
  ImageIcon,
  FileCheck2,
  FolderTree,
  Upload,
  DollarSign,
  ScanLine,
  Printer,
} from "lucide-react";
import { useInventoryLabelPrinter } from "@/hooks/inventory/useInventoryLabelPrinter";
import { printLabelByTemplate } from "@/services/printing/labelDispatch";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import { ProductImageUpload } from "@/components/products/ProductImageUpload";
import { ProductCategorySelector } from "@/components/products/ProductCategorySelector";
import { ProductCategoriesManager, getCategoryColorClass } from "@/components/products/ProductCategoriesManager";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { DataTablePagination } from "@/components/common/DataTablePagination";
import { useDebouncedCallback } from "@/hooks/useDebouncedCallback";
import { CustomFieldsSection } from "@/components/studio/CustomFieldsSection";
import { CustomizeFieldsButton } from "@/components/studio/CustomizeFieldsButton";
import {
  EtimsUnitCodeSelect,
  EtimsPackagingCodeSelect,
  EtimsClassificationCodeSelect,
  EtimsCountryOriginSelect,
} from "@/components/etims/EtimsCodeSelectors";
import { ScannerPairingButton } from "@/components/scanner/ScannerPairingButton";
import { useScanTarget } from "@/hooks/pos/useScanTarget";
import { useActiveScanContext } from "@/hooks/pos/useActiveScanContext";
import { playPOSSound } from "@/lib/pos/sounds";

import { Separator } from "@/components/ui/separator";
import { useEtimsTaxCategories } from "@/hooks/useEtimsTaxCategories";
import { ProductDetailPanel } from "@/components/products/detail/ProductDetailPanel";
import { useTaxCompliance } from "@/hooks/useTaxCompliance";
import { ReportExportButtons } from "@/components/reports/ReportExportButtons";
import { type ExportConfig, type ExportColumn } from "@/services/reports/ReportExportService";
import { ProductAccountSelector } from "@/components/products/ProductAccountSelector";
import { ProductStockPanel } from "@/components/products/ProductStockPanel";
import { useQuery, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useBranches } from "@/hooks/useBranches";
import { useWarehouses } from "@/hooks/useWarehouses";
import { ExternalLink } from "lucide-react";
import {
  ProductIdentifiersEditor,
  type ProductIdentifiersEditorHandle,
} from "@/components/products/ProductIdentifiersEditor";
import {
  ProductPackagingEditor,
  type ProductPackagingEditorHandle,
} from "@/components/products/ProductPackagingEditor";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ChevronDown } from "lucide-react";
import { UomSelect } from "@/components/products/UomSelect";
import { normalizeError } from "@/services/resilience";

export default function Products() {
  const [searchParams] = useSearchParams();
  // Group C #3 — every routed scan in the Products workspace is audited
  // to `scan_events` via the `workspace_id` lane. Includes the
  // scan-to-onboard target below and the ProductIdentifiersEditor
  // fallback target when the editor is mounted inside this page.
  useActiveScanContext({ workspace_id: "products" });
  // View mode state
  const { currentView, selectedSavedView, setView } = useViewMode({ entityType: "product" });

  // Core field display overrides from Studio
  const coreFieldDisplay = useCoreFieldDisplay("product");

  // Default list columns - can be overridden by saved list views in Studio
  const defaultProductColumns: DefaultColumn[] = coreFieldDisplay.applyToColumns([
    { field: "image", label: "Image", visible: true },
    { field: "name", label: "Name", visible: true },
    { field: "type", label: "Type", visible: true },
    { field: "category", label: "Category", visible: true },
    { field: "sku", label: "SKU", visible: true },
    { field: "stock", label: "Stock", visible: true },
    { field: "price", label: "Price", visible: true },
    { field: "cost", label: "Cost", visible: true },
  ]);
  const { visibleColumns } = useListViewColumns("product", defaultProductColumns);
  
  // Custom field filtering
  const { filters: customFieldFilters, setFilters: setCustomFieldFilters, filterEntityIds, isFiltering: isCustomFiltering } = useCustomFieldFiltering("product");

  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [showCategoriesManager, setShowCategoriesManager] = useState(false);
  const [showImportWizard, setShowImportWizard] = useState(false);

  // Debounce search input to avoid too many API calls
  const debouncedSetSearch = useDebouncedCallback((value: string) => {
    setDebouncedSearch(value);
  }, 300);

  const filters = useMemo(() => ({
    search: debouncedSearch,
    type: typeFilter,
    category_id: categoryFilter,
  }), [debouncedSearch, typeFilter, categoryFilter]);

  const { 
    products, 
    isLoading, 
    isFetching,
    pagination,
    setPage,
    setPageSize,
    createProduct, 
    updateProduct, 
    deleteProduct 
  } = useProductsPaginated(filters);
  
  const { formatCurrency, isReady: currencyReady } = useCurrency();
  const { currentOrg } = useOrganization();
  const { currentBusiness, isLoading: businessLoading } = useBusinesses();
  const { industry: businessIndustry, profile: industryProfile } = useIndustryProfile();
  const { currentBranch } = useBranches();
  const { activeWarehouses } = useWarehouses();
  const queryClient = useQueryClient();
  // Per-warehouse opening balances. Only honored on CREATE for tracked
  // products. Stock truth still flows exclusively through stock_adjustments
  // (reason='opening_balance') so the ledger, AVCO, and GL stay consistent.
  const [openingByWarehouse, setOpeningByWarehouse] = useState<Record<string, number>>({});
  // Per-warehouse opening unit cost. Defaults from product cost_price but is
  // editable per warehouse. Server requires unit_cost > 0 on every opening
  // line (otherwise the JE cannot be posted — see Wave 11 migration).
  const [openingCostByWarehouse, setOpeningCostByWarehouse] = useState<Record<string, number>>({});
  const { canManageProducts } = usePermissions();
  const { taxRates } = useTaxRates();
  const { flatTreeList: categoryOptions, categories } = useProductCategories();
  const { toast } = useToast();
  const navigate = useNavigate();
  const labelPrinter = useInventoryLabelPrinter();

  // Wave B2.2 — template-driven product label printing.
  //
  // The label body, dimensions, and engine are owned by `label_templates`
  // (resolved server-side via `resolve_label_template`, branch override →
  // org default → none). This page only contributes the *vars* (product
  // name, SKU, barcode) — never the raw ZPL/ESCPOS bytes. That keeps every
  // tenant free to swap layouts, sizes, barcode formats, and promotional
  // tokens without code changes, and keeps the page out of the way of the
  // ESLint guard `no-raw-zpl-outside-printing`.
  //
  // We still consume `useInventoryLabelPrinter` for the missing-device CTA
  // (it pre-flights the `label_printer` role binding and surfaces the
  // Platform → Hardware link when nothing is bound). The actual print
  // dispatch goes through `printLabelByTemplate`, which resolves the
  // workflow-bound printer (`product_tag`) and emits via `hardwareClient`
  // under the `label_printer` role with full Track-1 audit linkage.
  const handlePrintLabel = async (product: Product) => {
    if (labelPrinter.missingDeviceCta) {
      toast({
        title: "No label printer assigned",
        description: labelPrinter.missingDeviceCta.message,
        variant: "destructive",
      });
      return;
    }
    if (!currentOrg?.id) {
      toast({
        title: "No active organization",
        description: "Select an organization before printing labels.",
        variant: "destructive",
      });
      return;
    }
    const code = (product as any).barcode || product.sku || product.id;
    const result = await printLabelByTemplate({
      orgId: currentOrg.id,
      branchId: currentBranch?.id ?? null,
      templateKey: "product_label",
      workflow: "product_tag",
      vars: {
        name: (product.name || "").slice(0, 80),
        sku: product.sku ?? "",
        barcode: code,
      },
      sourceDocType: "product",
      sourceDocId: product.id,
      idempotencyKey: `product_label:${product.id}:${Date.now()}`,
    });
    toast({
      title: result.success ? "Label sent to printer" : "Print failed",
      description: result.success
        ? `Sent label for ${product.name} to ${labelPrinter.device?.display_name ?? "printer"}.`
        : result.error ?? "Unknown printer error",
      variant: result.success ? "default" : "destructive",
    });
  };
  const { isComplianceAvailable, complianceInfo } = useTaxCompliance();
  const categoryResolverRef = useRef<CategoryResolver | null>(null);

  const productFieldDefinitions = PRODUCT_IMPORT_FIELDS;

  // Per-product on-hand from warehouse_stock — branch-true.
  // products.stock_quantity is a company-wide aggregate maintained by a
  // trigger and must not be displayed when a branch context is active, or
  // operators in branch B will see branch A's stock summed in.
  const productIds = useMemo(() => products.map((p) => p.id), [products]);
  // Cache key uses the actual id-set hash (not just length) so adding a new
  // product with opening stock invalidates correctly even when count parity
  // happens to match (e.g. delete + create in same render cycle).
  const productIdsKey = useMemo(() => [...productIds].sort().join(","), [productIds]);
  const {
    data: stockByProduct,
    isLoading: stockLoading,
    isFetching: stockFetching,
  } = useQuery({
    queryKey: ["products-list-stock", currentOrg?.id, currentBusiness?.id, currentBranch?.id, productIdsKey],
    refetchOnWindowFocus: true,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      if (!currentOrg?.id || !currentBusiness?.id || productIds.length === 0) {
        return new Map<string, number>();
      }
      let q = supabase
        .from("warehouse_stock")
        .select("product_id, quantity")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .in("product_id", productIds);
      if (currentBranch?.id) q = q.eq("branch_id", currentBranch.id);
      const { data, error } = await q;
      if (error) throw error;
      const map = new Map<string, number>();
      for (const r of data || []) {
        map.set(r.product_id, (map.get(r.product_id) || 0) + (Number(r.quantity) || 0));
      }
      return map;
    },
    enabled: !!currentOrg?.id && !!currentBusiness?.id && productIds.length > 0,
  });


  // Batched packaging fetch — drives pack rollup in StockCell and the
  // Multi-UoM badge in ProductBadgeStrip. One query for the whole page.
  const { packsByProduct, hasPackagingSet } = useProductPackagingBatch(productIds);

  const handleImportProduct = async (row: Record<string, any>) => {
    if (!currentOrg) throw new Error("No organization selected");

    // Lazy-init resolver with current categories
    if (!currentBusiness?.id) throw new Error("Select a Company before importing products");

    if (!categoryResolverRef.current) {
      categoryResolverRef.current = new CategoryResolver(currentOrg.id, currentBusiness.id, categories);
    }

    let categoryId: string | null = null;
    if (row.category) {
      categoryId = await categoryResolverRef.current.resolve(row.category);
    }

    const trackInventory = row.track_inventory
      ? ["yes", "true", "1", "tracked"].includes(String(row.track_inventory).toLowerCase())
      : normalizeProductType(row.type) === "product";

    const created = await createProduct({
      name: row.name,
      description: row.description || null,
      type: normalizeProductType(row.type),
      sku: row.sku || null,
      unit_price: row.unit_price || 0,
      cost_price: row.cost_price || 0,
      tax_rate: row.tax_rate || 0,
      category_id: categoryId,
      track_inventory: trackInventory,
      // NOTE: opening stock is intentionally NOT written here.
      // products.stock_quantity is a company-wide aggregate maintained by the
      // `update_product_stock` trigger; direct writes desync warehouse_stock.
      // For opening balances, use the dedicated Stock Adjustment ("opening")
      // flow against a chosen warehouse so the ledger and GL stay consistent.
      reorder_level: row.reorder_level || 0,
      is_active: true,
    });

    // Persist any imported barcode/GTIN as a scannable identifier. SKU is
    // already auto-seeded by the trg_sync_product_sku_to_identifiers trigger.
    const rawBarcode = row.barcode ? String(row.barcode).trim() : "";
    if (created?.id && rawBarcode && currentOrg && currentBusiness) {
      const codes = rawBarcode.split(/[,;|]/).map((s) => s.trim()).filter(Boolean);
      if (codes.length > 0) {
        await supabase
          .from("product_identifiers")
          .upsert(
            codes.map((code, i) => ({
              organization_id: currentOrg.id,
              business_id: currentBusiness.id,
              product_id: created.id,
              code,
              kind: "gtin" as const,
              is_primary: i === 0,
            })),
            { onConflict: "business_id,code_norm,kind", ignoreDuplicates: true },
          );
      }
    }
  };

  const handleImportComplete = () => {
    // Reset resolver cache so next import starts fresh
    categoryResolverRef.current = null;
  };
  const [showDialog, setShowDialog] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [viewingProduct, setViewingProduct] = useState<Product | null>(null);
  const [showDetailDialog, setShowDetailDialog] = useState(false);
  // Pre-fill barcode on first identifier row when coming from POS "Unknown barcode → Create product".
  const createWithCode = searchParams.get("createWithCode") || undefined;
  const identifiersRef = useRef<ProductIdentifiersEditorHandle | null>(null);
  // Buffers pending product_packaging rows for new products so the operator
  // defines packs and saves the product in one round-trip (no "Save then
  // re-open to add packaging" two-step).
  const packagingRef = useRef<ProductPackagingEditorHandle | null>(null);
  // Page-level scan-to-onboard: scans on /products with no focused barcode
  // field land here. Hit → open detail; miss → open Add-item with code prefilled.
  const [pendingCreateCode, setPendingCreateCode] = useState<string | null>(null);
  // Re-entry guard for page-level scan-to-onboard. The ref is the actual
  // guard (synchronous, race-proof); the state drives the router-active
  // gate + a "Looking up barcode…" toast so the operator gets immediate
  // feedback during the pos_resolve_barcode RPC and the Add-Item dialog
  // cannot open before the resolve completes.
  const resolvingScanRef = useRef(false);
  const [isResolvingScan, setIsResolvingScan] = useState(false);
  // Disclosure state for the advanced sales/purchase unit override panel.
  const [showAdvancedUoM, setShowAdvancedUoM] = useState(false);
  // Pre-flight lock check for base_uom_id (mirrors the DB trigger
  // enforce_base_uom_immutable). When locked we disable the picker and
  // explain the packaging escape hatch.
  const { data: uomLock } = useProductUomLock(editingProduct?.id ?? null);
  const baseUomLocked = !!uomLock?.locked;

  // Handle ?action=create from global create menu OR ?createWithCode=... from POS unknown-barcode recovery
  useEffect(() => {
    if ((searchParams.get("action") === "create" || searchParams.get("createWithCode")) && !showDialog) {
      setShowDialog(true);
    }
  }, [searchParams]);

  // Handle ?selected=productId to auto-open product detail
  useEffect(() => {
    const selectedId = searchParams.get("selected");
    if (selectedId && products.length > 0 && !showDetailDialog) {
      const found = products.find(p => p.id === selectedId);
      if (found) {
        setViewingProduct(found);
        setShowDetailDialog(true);
      }
    }
  }, [searchParams, products]);

  // Scan-to-onboard: page-level scan target at priority 5 so any focused
  // <BarcodeInputField> (priority 10) still wins. Resolves the code via
  // pos_resolve_barcode — hit opens the product detail dialog, miss opens
  // Add-item with the barcode prefilled.
  useScanTarget({
    active: !!currentBusiness?.id && !showDialog && !showDetailDialog && !isResolvingScan,
    priority: 5,
    label: "ProductsPage scan-to-onboard",
    onScan: async (e) => {
      // Drop duplicate scans (wedge replay, phone reconnect replay) while
      // a resolve is in flight — prevents the "Add Product opens, then
      // Found toast appears" race.
      if (resolvingScanRef.current) return;
      // Strip control chars (wedge CR/LF suffixes) before normalising,
      // otherwise the RPC can miss-match and trigger the onboarding path
      // for a barcode that actually exists.
      const code = e.code.replace(/[\x00-\x1F\x7F]/g, "").trim();
      if (!code || !currentBusiness?.id) return;
      resolvingScanRef.current = true;
      setIsResolvingScan(true);
      const loadingToast = toast({
        title: "Looking up barcode…",
        description: code,
      });
      try {
        const { data, error } = await supabase.rpc("pos_resolve_barcode" as any, {
          p_business_id: currentBusiness.id,
          p_branch_id: currentBranch?.id ?? null,
          p_code: code,
        } as any);
        if (error) throw error;
        const row = Array.isArray(data) && data.length > 0 ? (data[0] as any) : null;
        if (row) {
          playPOSSound("barcode_scan");
          const local = products.find((p) => p.id === row.product_id);
          if (local) {
            setViewingProduct(local);
            setShowDetailDialog(true);
          } else {
            const { data: prod } = await supabase
              .from("products")
              .select("*")
              .eq("id", row.product_id)
              .maybeSingle();
            if (prod) {
              setViewingProduct(prod as Product);
              setShowDetailDialog(true);
            }
          }
          toast({ title: `Found: ${row.name}` });
        } else {
          playPOSSound("low_stock_warning");
          resetForm();
          setPendingCreateCode(code);
          setShowDialog(true);
          toast({ title: "New barcode", description: "Fill in product details to onboard." });
        }
      } catch (err: any) {
        playPOSSound("error");
        toast({
          title: "Scan lookup failed",
          description: normalizeError(err).message ?? "Unknown error",
          variant: "destructive",
        });
      } finally {
        loadingToast.dismiss();
        resolvingScanRef.current = false;
        setIsResolvingScan(false);
      }
    },

  });

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
    // MOQ fields
    min_order_quantity: 1,
    order_quantity_increment: 1,
    // Category
    category_id: null as string | null,
    // Default GL account mappings
    sales_account_id: null as string | null,
    purchase_account_id: null as string | null,
    cogs_account_id: null as string | null,
    inventory_account_id: null as string | null,
    // eTIMS fields
    tax_rate_id: null as string | null,
    etims_classification_code: "",
    etims_unit_code: "U",
    etims_packaging_unit: "CT",
    // Country defaults from the business (legal entity), not the org tenant.
    etims_country_origin: currentBusiness?.country || "",
    // UoM (Phase B). `base_uom_id` is the unit `quantity` is denominated in on
    // the ledger; sales/purchase default to base.
    base_uom_id: null as string | null,
    sales_uom_id: null as string | null,
    purchase_uom_id: null as string | null,
    // Lot / expiry tracking (Phase 8). When `is_lot_tracked` is on, every
    // outbound RPC requires a lot allocation (auto-FEFO or explicit). When
    // `is_expiry_tracked` is also on, the lot's expiry date drives the
    // dashboard "Lots expiring soon" widget through `v_lots_expiring_soon`.
    is_lot_tracked: industryProfile.defaultLotTracking,
    is_expiry_tracked: industryProfile.defaultExpiryTracking,
    expiry_alert_days: 30,
  });

  const resetForm = () => {
    setFormData({
      name: "",
      description: "",
      type: "service",
      sku: "",
      unit_price: 0,
      cost_price: 0,
      tax_rate: 0,
      image_url: null,
      track_inventory: false,
      stock_quantity: 0,
      reorder_level: 0,
      reorder_quantity: 0,
      min_order_quantity: 1,
      order_quantity_increment: 1,
      category_id: null,
      sales_account_id: null,
      purchase_account_id: null,
      cogs_account_id: null,
      inventory_account_id: null,
      tax_rate_id: null,
      etims_classification_code: "",
      etims_unit_code: "U",
      etims_packaging_unit: "CT",
      etims_country_origin: currentBusiness?.country || "",
      base_uom_id: null,
      sales_uom_id: null,
      purchase_uom_id: null,
      is_lot_tracked: industryProfile.defaultLotTracking,
      is_expiry_tracked: industryProfile.defaultExpiryTracking,
      expiry_alert_days: 30,
    });
    setEditingProduct(null);
    setOpeningByWarehouse({});
  };

  const handleOpenDialog = (product?: Product) => {
    if (product) {
      setEditingProduct(product);
      setFormData({
        name: product.name,
        description: product.description || "",
        type: product.type,
        sku: product.sku || "",
        unit_price: product.unit_price,
        cost_price: product.cost_price || 0,
        tax_rate: product.tax_rate || 0,
        image_url: product.image_url,
        track_inventory: (product as any).track_inventory || false,
        stock_quantity: (product as any).stock_quantity || 0,
        reorder_level: (product as any).reorder_level || 0,
        reorder_quantity: (product as any).reorder_quantity || 0,
        min_order_quantity: product.min_order_quantity || 1,
        order_quantity_increment: product.order_quantity_increment || 1,
        category_id: (product as any).category_id || null,
        sales_account_id: product.sales_account_id || null,
        purchase_account_id: (product as any).purchase_account_id || null,
        cogs_account_id: product.cogs_account_id || null,
        inventory_account_id: product.inventory_account_id || null,
        tax_rate_id: (product as any).tax_rate_id || null,
        etims_classification_code: (product as any).etims_classification_code || "",
        etims_unit_code: (product as any).etims_unit_code || "U",
        etims_packaging_unit: (product as any).etims_packaging_unit || "CT",
        etims_country_origin: (product as any).etims_country_origin || currentBusiness?.country || "",
        base_uom_id: (product as any).base_uom_id || null,
        sales_uom_id: (product as any).sales_uom_id || null,
        purchase_uom_id: (product as any).purchase_uom_id || null,
        is_lot_tracked: !!(product as any).is_lot_tracked,
        is_expiry_tracked: !!(product as any).is_expiry_tracked,
        expiry_alert_days: (product as any).expiry_alert_days ?? 30,
      });
    } else {
      resetForm();
    }
    setShowDialog(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);

    try {
      if (editingProduct) {
        await updateProduct(editingProduct.id, formData);
        toast({ title: "Product updated successfully" });
        setShowDialog(false);
        resetForm();
      } else {
        // Opening-balance shortcut (QuickBooks-style "Initial qty on hand").
        // When the user supplied positive opening qty per warehouse and the
        // product tracks inventory, create the product AND opening stock in
        // a single atomic RPC so we never end up with an orphan product
        // (the old compensating-delete pattern produced the INSERT→DELETE
        // realtime burst on any opening-stock failure).
        const openingItems = Object.entries(openingByWarehouse)
          .filter(([, qty]) => Number(qty) > 0)
          .map(([warehouse_id, qty]) => {
            const perWarehouseCost = Number(openingCostByWarehouse[warehouse_id]);
            const fallbackCost = Number(formData.cost_price) || 0;
            const unitCost = perWarehouseCost > 0 ? perWarehouseCost : fallbackCost;
            return {
              warehouse_id,
              quantity_adjustment: Number(qty),
              unit_cost: unitCost,
            };
          });

        const useAtomic =
          formData.track_inventory && openingItems.length > 0 && !!currentOrg && !!currentBusiness;

        // Client-side guard mirroring the server-side OPENING_STOCK_REQUIRES_COST
        // RAISE — fail fast with an actionable toast instead of a 500.
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
            // PostgREST overload-resolution failure. If this fires, the DB has
            // drifted (duplicate overload reintroduced, or schema cache stale).
            // We intentionally do NOT silently fall back to a non-atomic
            // product insert — that would create the product without the
            // opening-stock journal entry and corrupt the GL.
            if (code === "PGRST202" || code === "PGRST203" || msg.includes("Could not find the function")) {
              throw new Error(
                "Inventory RPC is out of sync (create_product_with_opening_stock_atomic). " +
                  "Please reload the page. If the problem persists, contact support — " +
                  "do not bypass opening stock, it would break the general ledger.",
              );
            }
            // Translate the server's strict valuation error into a friendly toast.
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

          const requiresApproval =
            result.opening_stock?.requires_approval === true;
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
                  navigate(
                    `/finance/journal-entries?selected=${String(journalEntryId)}`,
                  )
                }
              >
                View entry
              </ToastAction>
            ) : undefined,
          });



          // Make sure any newly-created adjustment/movement is reflected.
          queryClient.invalidateQueries({ queryKey: ["stock-adjustments"] });
          queryClient.invalidateQueries({ queryKey: ["stock-movements"] });
          queryClient.invalidateQueries({ queryKey: ["warehouse-stock-totals"] });
          queryClient.invalidateQueries({ queryKey: ["products-list-stock"] });
          queryClient.invalidateQueries({ queryKey: ["products-paginated"] });
          queryClient.invalidateQueries({ queryKey: ["journal-entries"] });
        } else {
          const created = await createProduct({
            ...formData,
            is_active: true,
          });
          createdId = created.id;
          toast({ title: "Product created successfully" });
        }

        // Persist any pending barcodes/identifiers the user added in the form.
        // SKU is auto-seeded into product_identifiers by a DB trigger; this
        // covers extra GTIN/EAN/pack/supplier codes typed or scanned in.
        try {
          await identifiersRef.current?.commit(createdId);
        } catch (idErr) {
          console.error("[Products] identifier commit failed", idErr);
        }

        // Flush pending packaging rows from the create-mode buffer. Runs after
        // identifier commit so the editor can bind packs to barcodes the
        // operator added in the same dialog session.
        try {
          await packagingRef.current?.commit(createdId);
        } catch (pkgErr: any) {
          console.error("[Products] packaging commit failed", pkgErr);
          toast({
            title: "Product created — packaging save failed",
            description: pkgErr?.message ?? "Open the product to retry.",
            variant: "destructive",
          });
        }

        setShowDialog(false);
        setPendingCreateCode(null);
        resetForm();
      }
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

  const executeDeleteProduct = async (product: Product) => {
    try {
      await deleteProduct(product.id);
      toast({ title: "Product deleted successfully" });
    } catch (error: any) {
      toast({
        title: "Error deleting product",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    }
  };

  const deleteConfirm = useConfirmDelete<Product>({ onConfirm: executeDeleteProduct });

  const handleDelete = (product: Product) => {
    deleteConfirm.requestDelete(product);
  };

  // Compute product/service counts from current page data + type filter context
  const stats = useMemo(() => {
    const productCount = products.filter((p) => p.type === "product").length;
    const serviceCount = products.filter((p) => p.type === "service").length;
    return {
      total: pagination.totalCount,
      products: typeFilter === "service" ? 0 : productCount,
      services: typeFilter === "product" ? 0 : serviceCount,
    };
  }, [products, pagination.totalCount, typeFilter]);

  return (
    <>
      <div className="space-y-4 sm:space-y-6">
        <div className="page-header">
          <div>
            <h1 className="page-title">Products & Services</h1>
            <p className="text-sm sm:text-base text-muted-foreground">
              Manage your catalog of products and services
            </p>
          </div>
          <div className="action-buttons w-full sm:w-auto">
            <RefreshButton
              queryKeyPrefixes={[
                ["products-paginated"] as const,
                ["products-list-stock"] as const,
                ["low-stock-products"] as const,
                ["product-categories"] as const,
              ]}
              tooltip="Refresh products & stock"
            />
            <CustomizeFieldsButton entityType="product" />
            <StudioQuickPanelTrigger entityType="product" />
            <ViewSwitcher
              entityType="product"
              currentView={currentView}
              onViewChange={setView}
            />
            {canManageProducts && (
              <>
                <ReportExportButtons
                  compact
                  formats={["excel", "csv", "print", "pdf"]}
                  getExportConfig={() => {
                    const cols: ExportColumn[] = [
                      { key: "name", header: "Product", width: 25 },
                      { key: "sku", header: "SKU", width: 15 },
                      { key: "type", header: "Type", width: 10 },
                      { key: "price", header: "Unit Price", format: "currency", width: 14, align: "right" },
                      { key: "cost", header: "Cost Price", format: "currency", width: 14, align: "right" },
                      { key: "stock", header: "Stock Qty", format: "number", width: 12, align: "right" },
                      { key: "reorder", header: "Reorder Level", format: "number", width: 14, align: "right" },
                    ];
                    const rows = products.map((p) => ({
                      name: p.name,
                      sku: p.sku || "",
                      type: p.type,
                      price: p.unit_price,
                      cost: p.cost_price || 0,
                      stock: p.stock_quantity || 0,
                      reorder: p.reorder_level || 0,
                    }));
                    return {
                      title: "Inventory Summary",
                      companyName: currentOrg?.name,
                      columns: cols,
                      rows,
                      organizationId: currentOrg?.id,
                    } as ExportConfig;
                  }}
                />
                <ScannerPairingButton
                  businessId={currentBusiness?.id}
                  branchId={currentBranch?.id ?? null}
                  label="Product onboarding"
                />
                <Button variant="outline" onClick={() => setShowCategoriesManager(true)} className="flex-1 sm:flex-none">
                  <FolderTree className="mr-2 h-4 w-4" />
                  Categories
                </Button>
                <Button variant="outline" asChild className="flex-1 sm:flex-none">
                  <Link to="/inventory-app/products/enroll">
                    <ScanLine className="mr-2 h-4 w-4" />
                    Enroll barcodes
                  </Link>
                </Button>
                <Button variant="outline" onClick={() => setShowImportWizard(true)} className="flex-1 sm:flex-none">
                  <Upload className="mr-2 h-4 w-4" />
                  Import
                </Button>
                <Button onClick={() => handleOpenDialog()} className="flex-1 sm:flex-none">
                  <Plus className="mr-2 h-4 w-4" />
                  Add Item
                </Button>
              </>
            )}
          </div>
        </div>

        {/* Stats */}
        <div className="stats-grid grid-cols-1 sm:grid-cols-3">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Items</CardTitle>
              <Package className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.total}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Products</CardTitle>
              <Package className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.products}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Services</CardTitle>
              <Briefcase className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.services}</div>
            </CardContent>
          </Card>
        </div>

        {/* Filters */}
        <div className="filter-bar">
          <div className="relative flex-1 min-w-0">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search products..."
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                debouncedSetSearch(e.target.value);
              }}
              className="pl-10 w-full"
            />
          </div>
          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger className="w-full sm:w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Types</SelectItem>
              <SelectItem value="product">Products</SelectItem>
              <SelectItem value="service">Services</SelectItem>
            </SelectContent>
          </Select>
          <Select value={categoryFilter} onValueChange={setCategoryFilter}>
            <SelectTrigger className="w-full sm:w-48">
              <SelectValue placeholder="All Categories" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Categories</SelectItem>
              {categoryOptions.map((cat) => (
                <SelectItem key={cat.id} value={cat.id}>
                  {"— ".repeat(cat.depth)}{cat.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <CustomFieldFilters entityType="product" filters={customFieldFilters} onFiltersChange={setCustomFieldFilters} />

        {/* Dynamic Views */}
        <DynamicViewsRenderer
          currentView={currentView}
          selectedSavedView={selectedSavedView}
          data={products as unknown as Record<string, unknown>[]}
          isLoading={isLoading}
        />

        {/* Table */}
        {currentView === "list" && <Card>
          <CardContent className="p-0">
            {(!businessLoading && !currentBusiness) ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <Package className="h-12 w-12 text-muted-foreground mb-4" />
                <h3 className="text-lg font-medium">No business configured</h3>
                <p className="text-sm text-muted-foreground">
                  Your organization doesn't have a business set up yet. Please contact your administrator.
                </p>
              </div>
            ) : (isLoading || !currencyReady) ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            ) : products.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <Package className="h-12 w-12 text-muted-foreground mb-4" />
                <h3 className="text-lg font-medium">No products found</h3>
                <p className="text-muted-foreground">
                  {pagination.totalCount === 0
                    ? "Get started by adding your first product or service."
                    : "Try adjusting your search or filter."}
                </p>
              </div>
            ) : (
              <>
              <div className="table-container">
              <Table>
                <TableHeader>
                  <TableRow>
                    {visibleColumns.map(col => (
                      <TableHead key={col.field} className={
                        col.field === "image" ? "w-16" :
                        col.field === "stock" || col.field === "price" || col.field === "cost" ? "text-right" : ""
                      }>
                        {col.label}
                      </TableHead>
                    ))}
                    <TableHead className="w-12"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {products.map((product) => {
                    const trackInventory = (product as any).track_inventory;
                    // Branch-true: read from warehouse_stock aggregate scoped
                    // by the active branch. Falls back to 0 (not the company
                    // total) so branch B never sees branch A's stock.
                    const hasStock = stockByProduct?.has(product.id) ?? false;
                    const stockQty = stockByProduct?.get(product.id) ?? 0;
                    const stockPending = stockLoading || (stockFetching && !hasStock);
                    const reorderLevel = (product as any).reorder_level || 0;
                    const isLowStock = trackInventory && hasStock && stockQty <= reorderLevel;
                    
                    return (
                      <TableRow key={product.id} className="cursor-pointer hover:bg-muted/50" onClick={() => { setViewingProduct(product); setShowDetailDialog(true); }}>
                        {visibleColumns.map(col => {
                          switch (col.field) {
                            case "image":
                              return (
                                <TableCell key="image">
                                  <div className="h-12 w-12 sm:h-14 sm:w-14 rounded-lg border bg-muted overflow-hidden flex items-center justify-center">
                                    {product.image_url ? (
                                      <img
                                        src={product.image_url}
                                        alt={product.name}
                                        className="h-full w-full object-cover"
                                        onError={(e) => {
                                          (e.target as HTMLImageElement).style.display = "none";
                                          (e.target as HTMLImageElement).nextElementSibling?.classList.remove("hidden");
                                        }}
                                      />
                                    ) : null}
                                    <ImageIcon className={`h-5 w-5 text-muted-foreground ${product.image_url ? "hidden" : ""}`} />
                                  </div>
                                </TableCell>
                              );
                            case "name":
                              return (
                                <TableCell key="name">
                                  <div>
                                    <div className="flex flex-wrap items-center gap-2">
                                      <span className="font-medium">{product.name}</span>
                                      <ProductBadgeStrip
                                        product={product}
                                        hasPackaging={hasPackagingSet.has(product.id)}
                                      />
                                    </div>
                                    {product.description && (
                                      <div className="text-sm text-muted-foreground truncate max-w-xs">
                                        {product.description}
                                      </div>
                                    )}
                                  </div>
                                </TableCell>
                              );
                            case "type":
                              return (
                                <TableCell key="type">
                                  <Badge variant="outline" className="capitalize">{product.type}</Badge>
                                </TableCell>
                              );
                            case "category":
                              return (
                                <TableCell key="category">
                                  {(product as any).category_id ? (
                                    (() => {
                                      const cat = categoryOptions.find(c => c.id === (product as any).category_id);
                                      return cat ? (
                                        <Badge variant="secondary" className={`text-xs ${getCategoryColorClass(cat.color)}`}>
                                          {cat.name}
                                        </Badge>
                                      ) : <span className="text-muted-foreground">—</span>;
                                    })()
                                  ) : (
                                    <span className="text-muted-foreground">—</span>
                                  )}
                                </TableCell>
                              );
                            case "sku":
                              return <TableCell key="sku">{product.sku || "-"}</TableCell>;
                            case "stock":
                              return (
                                <TableCell key="stock" className="text-right">
                                  <StockCell
                                    value={stockQty}
                                    reorderLevel={reorderLevel}
                                    trackInventory={trackInventory !== false}
                                    packs={packsByProduct.get(product.id)}
                                    baseLabel={(product as any).unit_of_measure ?? "ea"}
                                    isLoading={stockPending}
                                  />
                                </TableCell>
                              );
                            case "price":
                              return (
                                <TableCell key="price" className="text-right">
                                  {formatCurrency(product.unit_price)}
                                </TableCell>
                              );
                            case "cost":
                              return (
                                <TableCell key="cost" className="text-right">
                                  {formatCurrency(product.cost_price || 0)}
                                </TableCell>
                              );
                            default:
                              return <TableCell key={col.field}>{(product as any)[col.field] ?? ""}</TableCell>;
                          }
                        })}
                      {canManageProducts && (
                        <TableCell onClick={(e) => e.stopPropagation()}>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon">
                                <MoreHorizontal className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onClick={() => handleOpenDialog(product)}>
                                <Pencil className="mr-2 h-4 w-4" />
                                Edit
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => handlePrintLabel(product)}>
                                <Printer className="mr-2 h-4 w-4" />
                                Print label
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onClick={() => handleDelete(product)}
                                className="text-destructive"
                              >
                                <Trash2 className="mr-2 h-4 w-4" />
                                Delete
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                      )}
                      {!canManageProducts && <TableCell />}
                    </TableRow>
                  );
                  })}
                </TableBody>
              </Table>
            </div>
            <DataTablePagination
              pagination={pagination}
              onPageChange={setPage}
              onPageSizeChange={setPageSize}
              isLoading={isFetching}
            />
            </>
            )}
          </CardContent>
        </Card>}

        {/* Add/Edit Dialog */}
        <Dialog open={showDialog} onOpenChange={(o) => { setShowDialog(o); if (!o) setPendingCreateCode(null); }}>
          <DialogContent className="max-w-lg max-h-[90vh]">
            <DialogHeader>
              <DialogTitle>
                {editingProduct ? "Edit Product" : "Add New Product"}
              </DialogTitle>
              <DialogDescription>
                {editingProduct
                  ? "Update the product details below."
                  : "Fill in the details to add a new product or service."}
              </DialogDescription>
            </DialogHeader>

            <ScrollArea className="max-h-[calc(90vh-180px)] pr-4">
              <form onSubmit={handleSubmit} className="space-y-4">
                {/* Image Upload */}
                {currentOrg && (
                  <ProductImageUpload
                    currentImageUrl={formData.image_url}
                    onImageChange={(url) => setFormData({ ...formData, image_url: url })}
                    organizationId={currentOrg.id}
                    productId={editingProduct?.id}
                  />
                )}

                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2 md:col-span-2">
                    <Label htmlFor="name">Name *</Label>
                    <Input
                      id="name"
                      value={formData.name}
                      onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="type">Type *</Label>
                    <Select
                      value={formData.type}
                      onValueChange={(value: "product" | "service") =>
                        setFormData({ ...formData, type: value })
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="product">Product</SelectItem>
                        <SelectItem value="service">Service</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <ProductCategorySelector
                    value={formData.category_id}
                    onChange={(id) => setFormData({ ...formData, category_id: id })}
                    disabled={isSubmitting}
                  />
                  <div className="space-y-2">
                    <Label htmlFor="sku">SKU</Label>
                    <Input
                      id="sku"
                      value={formData.sku}
                      onChange={(e) => setFormData({ ...formData, sku: e.target.value })}
                    />
                  </div>
                  {currentOrg && currentBusiness && (
                    <div className="md:col-span-2">
                      <ProductIdentifiersEditor
                        ref={identifiersRef}
                        productId={editingProduct?.id ?? null}
                        organizationId={currentOrg.id}
                        businessId={currentBusiness.id}
                        initialBarcode={!editingProduct ? (pendingCreateCode ?? createWithCode) : undefined}
                      />
                    </div>
                  )}
                  {formData.type === "product" && currentOrg && currentBusiness && (
                    <div className="md:col-span-2">
                      <ProductPackagingEditor
                        ref={packagingRef}
                        productId={editingProduct?.id ?? null}
                        organizationId={currentOrg.id}
                        businessId={currentBusiness.id}
                      />
                    </div>
                  )}
                  {formData.type === "product" && (
                    <div className="md:col-span-2 rounded-md border p-3 space-y-3">
                      <div className="space-y-2">
                        <Label>Inventory unit *</Label>
                        <UomSelect
                          value={formData.base_uom_id}
                          disabled={baseUomLocked}
                          onChange={(id) =>
                            setFormData({
                              ...formData,
                              base_uom_id: id,
                              // Re-sync sales/purchase to the new base. The
                              // DB enforces same-category for all three, so a
                              // stale sibling from a different category would
                              // produce a 23514. Operators can re-pick a
                              // same-category override from the Advanced panel.
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
                              {uomLock?.reason} Changing the inventory unit
                              after the product has been transacted would
                              silently rescale stock value and history. To buy
                              or sell in a different unit (e.g. grams against a
                              KG base), add a <strong>Packaging</strong> entry
                              above with the right multiplier.
                            </p>
                          </div>
                        ) : (
                          <p className="text-xs text-muted-foreground">
                            Stock and cost are stored in this unit. Add packs
                            above to buy or sell in cartons, strips, etc.
                          </p>
                        )}
                      </div>
                      <Collapsible
                        open={showAdvancedUoM}
                        onOpenChange={setShowAdvancedUoM}
                      >
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
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
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
                          </div>
                          <p className="text-xs text-muted-foreground pt-2">
                            Most products sell and buy in the same unit. Only set
                            these when sales/purchase use a different UoM
                            category (e.g. inventory in pieces but sales in kg).
                          </p>
                        </CollapsibleContent>
                      </Collapsible>
                    </div>
                  )}
                  {formData.type === "product" && formData.track_inventory && (
                    <div className="md:col-span-2 rounded-md border p-3 space-y-3">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <Label className="text-sm font-medium">Track lot / batch numbers</Label>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            Each receipt records a lot number. Sales, deliveries
                            and POS auto-pick lots first-expiry-first-out (FEFO),
                            or you can override at checkout.
                          </p>
                          {!editingProduct &&
                            businessIndustry &&
                            industryProfile.defaultLotTracking && (
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
                              // Expiry tracking implies lot tracking; clear the
                              // dependent toggles when lots are turned off.
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
                                Surfaces lots in the "Lots expiring soon"
                                dashboard widget once they enter the alert window.
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
                                Lots within this many days of expiry appear on
                                the inventory dashboard. Defaults to 30.
                              </p>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  )}
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
                    <Label htmlFor="tax_rate">Tax Rate</Label>
                    <Select
                      value={formData.tax_rate_id || "custom"}
                      onValueChange={(v) => {
                        if (v === "custom") {
                          setFormData({ 
                            ...formData, 
                            tax_rate_id: null,
                          });
                        } else if (v === "none") {
                          setFormData({ 
                            ...formData, 
                            tax_rate_id: null,
                            tax_rate: 0,
                          });
                        } else {
                          const selectedRate = taxRates.find(t => t.id === v);
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
                        {taxRates.filter(t => t.is_active).map((rate) => (
                          <SelectItem key={rate.id} value={rate.id}>
                            <div className="flex items-center gap-2">
                              <span>{rate.name} ({rate.rate}%)</span>
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
                    {!formData.tax_rate_id && formData.tax_rate !== 0 && (
                      <div className="flex gap-2 items-center mt-2">
                        <Input
                          id="tax_rate"
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
                    {!formData.tax_rate_id && formData.tax_rate > 0 && (
                      <p className="text-xs text-amber-600">
                        ⚠️ Custom rate - select a tax code in eTIMS section below for compliance
                      </p>
                    )}
                  </div>
                  <div className="space-y-2 md:col-span-2">
                    <Label htmlFor="description">Description</Label>
                    <Textarea
                      id="description"
                      value={formData.description}
                      onChange={(e) =>
                        setFormData({ ...formData, description: e.target.value })
                      }
                      rows={3}
                    />
                  </div>

                  {/* Inventory Tracking Section - only for products */}
                  {formData.type === "product" && (
                    <>
                      <div className="md:col-span-2 pt-4 border-t">
                        <div className="flex items-center justify-between">
                          <div>
                            <Label htmlFor="track_inventory" className="text-base font-medium">
                              Track Inventory
                            </Label>
                            <p className="text-sm text-muted-foreground">
                              Enable stock tracking for this product
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
                      </div>

                      {formData.track_inventory && (
                        <>
                          {editingProduct ? (
                            <ProductStockPanel
                              productId={editingProduct.id}
                              productName={formData.name}
                              costPrice={Number(formData.cost_price) || 0}
                              unitPrice={Number(formData.unit_price) || 0}
                            />
                          ) : (
                            <div className="space-y-2 md:col-span-2 rounded-md border bg-muted/20 p-4">
                              <Label className="text-sm font-semibold">Stock</Label>
                              <p className="text-xs text-muted-foreground">
                                Stock totals are derived from movements (receipts,
                                sales, transfers, adjustments) so valuation and the
                                GL stay in sync. Use the <strong>Opening stock per
                                warehouse</strong> block below to seed initial
                                quantities — they post as a stock adjustment with
                                <code className="mx-1 text-[10px]">reason: opening_balance</code>
                                after the product is saved.
                              </p>
                            </div>
                          )}

                          {/* Opening stock per warehouse — CREATE only.
                              Posts a stock_adjustment with reason='opening_balance'
                              after the product is saved, so the ledger, AVCO,
                              and GL all stay consistent (ADR 0001 / 0002). */}
                          {!editingProduct && activeWarehouses.length > 0 && (
                            <div className="md:col-span-2 space-y-2 rounded-md border border-dashed p-3">
                              <div className="flex items-center justify-between">
                                <Label className="text-sm font-medium">Opening stock per warehouse</Label>
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
                                  const cost =
                                    openingCostByWarehouse[wh.id] ??
                                    (Number(formData.cost_price) || 0);
                                  const showCostError = Number(qty) > 0 && !(Number(cost) > 0);
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
                                // Live GL preview — Σ(qty × unit_cost), cost-based.
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
                                      Valued at cost. Creating the product with no opening quantity
                                      posts nothing to the general ledger.
                                    </p>
                                  </div>
                                );
                              })()}
                              <p className="text-xs text-muted-foreground">
                                Posted as a stock adjustment ({`reason: opening_balance`}) and a
                                balanced journal entry (Inventory ⇄ Opening Balance Equity). Every
                                line with a quantity needs a positive unit cost — quantity-only
                                opening stock is not allowed because it would bypass the GL.
                              </p>

                            </div>
                          )}
                          <div className="space-y-2">
                            <Label htmlFor="reorder_level">Reorder Level</Label>
                            <Input
                              id="reorder_level"
                              type="number"
                              min="0"
                              value={formData.reorder_level}
                              onChange={(e) =>
                                setFormData({ ...formData, reorder_level: parseInt(e.target.value) || 0 })
                              }
                            />
                            <p className="text-xs text-muted-foreground">
                              Alert when stock falls below this level
                            </p>
                          </div>
                          <div className="space-y-2">
                            <Label htmlFor="reorder_quantity">Reorder Quantity</Label>
                            <Input
                              id="reorder_quantity"
                              type="number"
                              min="0"
                              value={formData.reorder_quantity}
                              onChange={(e) =>
                                setFormData({ ...formData, reorder_quantity: parseInt(e.target.value) || 0 })
                              }
                            />
                            <p className="text-xs text-muted-foreground">
                              Suggested quantity to reorder
                            </p>
                          </div>
                        </>
                      )}

                      {/* MOQ Section */}
                      <div className="md:col-span-2 pt-4 border-t">
                        <h4 className="text-sm font-medium mb-3">Minimum Order Requirements</h4>
                        <div className="grid gap-4 md:grid-cols-2">
                          <div className="space-y-2">
                            <Label htmlFor="min_order_quantity">Minimum Order Quantity</Label>
                            <Input
                              id="min_order_quantity"
                              type="number"
                              min="1"
                              step="1"
                              value={formData.min_order_quantity}
                              onChange={(e) =>
                                setFormData({ ...formData, min_order_quantity: parseInt(e.target.value) || 1 })
                              }
                            />
                            <p className="text-xs text-muted-foreground">
                              Minimum quantity that must be ordered
                            </p>
                          </div>
                          <div className="space-y-2">
                            <Label htmlFor="order_quantity_increment">Order Increment</Label>
                            <Input
                              id="order_quantity_increment"
                              type="number"
                              min="1"
                              step="1"
                              value={formData.order_quantity_increment}
                              onChange={(e) =>
                                setFormData({ ...formData, order_quantity_increment: parseInt(e.target.value) || 1 })
                              }
                            />
                            <p className="text-xs text-muted-foreground">
                              Must order in multiples of this value (e.g., case of 12)
                            </p>
                          </div>
                        </div>
                      </div>

                      {/* Accounting Defaults Section */}
                      <div className="md:col-span-2 pt-4 border-t">
                        <div className="flex items-center gap-2 mb-3">
                          <DollarSign className="h-4 w-4 text-muted-foreground" />
                          <h4 className="text-sm font-medium">Default GL Accounts</h4>
                        </div>
                        <p className="text-xs text-muted-foreground mb-4">
                          Optionally map this product to specific GL accounts. If left blank, system defaults are used.
                        </p>
                        <div className="grid gap-4 md:grid-cols-2">
                          <ProductAccountSelector
                            label="Sales Revenue Account"
                            value={formData.sales_account_id}
                            onChange={(v) => setFormData({ ...formData, sales_account_id: v })}
                            accountType="income"
                            helpText="Revenue account credited on sale"
                            disabled={isSubmitting}
                          />
                          {(formData.type === "product" || formData.track_inventory) && (
                            <>
                              <ProductAccountSelector
                                label="COGS Account"
                                value={formData.cogs_account_id}
                                onChange={(v) => setFormData({ ...formData, cogs_account_id: v })}
                                accountType="expense"
                                helpText="Cost of Goods Sold debited on sale"
                                disabled={isSubmitting}
                              />
                              <ProductAccountSelector
                                label="Inventory Account"
                                value={formData.inventory_account_id}
                                onChange={(v) => setFormData({ ...formData, inventory_account_id: v })}
                                accountType="asset"
                                helpText="Inventory asset account for stock valuation"
                                disabled={isSubmitting}
                              />
                            </>
                          )}
                        </div>
                      </div>

                      {/* Tax Compliance Configuration Section - Only shown when country has compliance provider */}
                      {isComplianceAvailable && (
                      <div className="md:col-span-2 pt-4 border-t">
                        <div className="flex items-center gap-2 mb-3">
                          <FileCheck2 className="h-4 w-4 text-muted-foreground" />
                          <h4 className="text-sm font-medium">Tax Compliance — {complianceInfo?.displayName}</h4>
                        </div>
                        <p className="text-xs text-muted-foreground mb-4">
                          Configure tax compliance codes for fiscal reporting. These codes will be transmitted with invoices and receipts.
                        </p>
                        <div className="grid gap-4 md:grid-cols-2">
                          <div className="space-y-2">
                            <Label>Tax Rate (with Compliance Code)</Label>
                            <Select
                              value={formData.tax_rate_id || "none"}
                              onValueChange={(v) => {
                                const selectedRate = taxRates.find(t => t.id === v);
                                setFormData({ 
                                  ...formData, 
                                  tax_rate_id: v === "none" ? null : v,
                                  tax_rate: selectedRate?.rate || 0
                                });
                              }}
                            >
                              <SelectTrigger>
                                <SelectValue placeholder="Select tax rate" />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="none">No tax</SelectItem>
                                {taxRates.filter(t => t.is_active).map((rate) => (
                                  <SelectItem key={rate.id} value={rate.id}>
                                    <div className="flex items-center gap-2">
                                      <span>{rate.name} ({rate.rate}%)</span>
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
                            value={formData.etims_classification_code}
                            onChange={(v) => setFormData({ ...formData, etims_classification_code: v })}
                          />
                          <EtimsUnitCodeSelect
                            value={formData.etims_unit_code}
                            onChange={(v) => setFormData({ ...formData, etims_unit_code: v })}
                          />
                          <EtimsPackagingCodeSelect
                            value={formData.etims_packaging_unit}
                            onChange={(v) => setFormData({ ...formData, etims_packaging_unit: v })}
                          />
                          <EtimsCountryOriginSelect
                            value={formData.etims_country_origin}
                            onChange={(v) => setFormData({ ...formData, etims_country_origin: v })}
                          />
                        </div>
                      </div>
                      )}
                    </>
                  )}
                </div>

                {/* Custom Fields Section */}
                <CustomFieldsSection
                  entityType="product"
                  entityId={editingProduct?.id || null}
                  formValues={formData}
                  disabled={isSubmitting}
                          />
                          <ProductAccountSelector
                            label="Purchase / Expense Account"
                            value={formData.purchase_account_id}
                            onChange={(v) => setFormData({ ...formData, purchase_account_id: v })}
                            accountType="expense"
                            helpText="Expense account debited when this item appears on a bill"
                            disabled={isSubmitting}
                          />

                <div className="flex justify-end gap-3 pt-4">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setShowDialog(false)}
                    disabled={isSubmitting}
                  >
                    Cancel
                  </Button>
                  {/* "Save & add packaging" two-step removed — the packaging
                      editor is now mounted inline for new products and the
                      ref's commit() flushes its buffer in the same save. */}
                  <Button type="submit" disabled={isSubmitting}>
                    {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    {editingProduct ? "Update" : "Add Item"}
                  </Button>
                </div>
              </form>
            </ScrollArea>
          </DialogContent>
        </Dialog>

        {/* Delete Confirmation Dialog */}
        <ConfirmDeleteDialog
          open={deleteConfirm.isOpen}
          onOpenChange={deleteConfirm.setIsOpen}
          title="Delete Product"
          itemName={deleteConfirm.itemToDelete?.name}
          onConfirm={deleteConfirm.confirmDelete}
          isLoading={deleteConfirm.isDeleting}
        />

        {/* Import Wizard */}
        <ImportWizard
          open={showImportWizard}
          onOpenChange={setShowImportWizard}
          entityName="Product"
          fieldDefinitions={productFieldDefinitions}
          onImport={handleImportProduct}
          onComplete={handleImportComplete}
        />

        {/* Categories Manager Dialog */}
        <ProductCategoriesManager
          open={showCategoriesManager}
          onOpenChange={setShowCategoriesManager}
        />

        {/* Product Detail Panel — context-aware, multi-tab inventory surface */}
        <ProductDetailPanel
          productId={viewingProduct?.id ?? null}
          initialProduct={viewingProduct ? { id: viewingProduct.id, name: viewingProduct.name, sku: viewingProduct.sku } : null}
          open={showDetailDialog}
          onOpenChange={setShowDetailDialog}
          onEdit={(id) => {
            const p = products.find((x) => x.id === id);
            if (p) handleOpenDialog(p);
          }}
          onDelete={(id) => {
            const p = products.find((x) => x.id === id);
            if (p) handleDelete(p);
          }}
          categoryName={viewingProduct?.category_id ? categoryOptions.find(c => c.id === viewingProduct.category_id)?.name : null}
        />
      </div>
    </>
  );
}
