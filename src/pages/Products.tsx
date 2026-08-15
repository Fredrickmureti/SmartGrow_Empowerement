import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { useSearchParams, Link, useNavigate } from "react-router-dom";
import { ConfirmDeleteDialog, useConfirmDelete } from "@/components/shared/ConfirmDeleteDialog";
import { useProductsPaginated } from "@/hooks/useProductsPaginated";
import { Product } from "@/hooks/useProducts";
// useProductUomLock moved to ProductForm.tsx (routed create/edit).
import { useCurrency } from "@/hooks/useCurrency";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { writeIdentifier } from "@/features/products/identity/writeIdentifier";
import { useIndustryProfile } from "@/hooks/useIndustryProfile";
import { usePermissions } from "@/hooks/usePermissions";
import { useViewMode } from "@/hooks/useViewMode";
import { useListViewColumns, DefaultColumn } from "@/hooks/useListViewColumns";
import { useCoreFieldDisplay } from "@/hooks/useCoreFieldDisplay";
import { useTaxRates } from "@/hooks/useTaxRates";
import { useTaxCompliance } from "@/hooks/useTaxCompliance";
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
// Inline record Dialog removed — Add/Edit Product now lives on the routed
// /inventory-app/products/new + /:id/edit RecordFormShell surfaces.
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
import { useLabelPrint } from "@/hooks/inventory/useLabelPrint";
import { PrintFilteredLabelsButton } from "@/components/labels/PrintFilteredLabelsButton";
import type { PrintableProduct } from "@/services/printing/labelBarcode";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ProductCategoriesManager, getCategoryColorClass } from "@/components/products/ProductCategoriesManager";
import { DataTablePagination } from "@/components/common/DataTablePagination";
import { useDebouncedCallback } from "@/hooks/useDebouncedCallback";
import { CustomizeFieldsButton } from "@/components/studio/CustomizeFieldsButton";
import { ScannerPairingButton } from "@/components/scanner/ScannerPairingButton";
import { useScanTarget } from "@/hooks/pos/useScanTarget";
import {
  resolveProductIdentityOnce,
  describeResolution,
} from "@/hooks/inventory/useResolveProductIdentity";
import { useActiveScanContext } from "@/hooks/pos/useActiveScanContext";
import { playPOSSound } from "@/lib/pos/sounds";

import { ProductDetailPanel } from "@/components/products/detail/ProductDetailPanel";
import { ReportExportButtons } from "@/components/reports/ReportExportButtons";
import { type ExportConfig, type ExportColumn } from "@/services/reports/ReportExportService";
import { useQuery, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useBranches } from "@/hooks/useBranches";
import { useWarehouses } from "@/hooks/useWarehouses";
import { ExternalLink } from "lucide-react";
import { normalizeError } from "@/services/resilience";
import { productBaseLabelOrUnset } from "@/lib/inventory/uom";


export default function Products() {
  const [searchParams, setSearchParams] = useSearchParams();
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
    // Admin product catalogue must show variant parents so they can be
    // authored / edited. Transactional pickers keep the default (excluded).
    includeVariantParents: true,
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
  const labelPrint = useLabelPrint({ branchId: currentBranch?.id ?? null });
  const labelPrinter = { missingDeviceCta: labelPrint.missingDeviceCta };

  // Template-driven product label printing.
  //
  // This page contributes *vars* only (product name, SKU, price) and the
  // template/workflow keys. Everything else — missing-device refusal,
  // ADR-0089 barcode-identity refusal, ADR-0088 mm-relative geometry,
  // template resolution, and operator toasts — is owned by the shared
  // `useLabelPrint` seam. Duplicating any of it here is what previously
  // let this page drift away from the rest of the label call sites.
  const handlePrintLabel = (product: Product) =>
    labelPrint.print({
      templateKey: "product_label",
      workflow: "product_tag",
      product: product as PrintableProduct,
    });

  // Shelf-edge label — goes to the shelf_edge workflow-bound printer, not
  // the general product_tag one (ADR-0086). Same barcode-identity rules,
  // enforced once inside the seam.
  const handlePrintShelfLabel = (product: Product) =>
    labelPrint.print({
      templateKey: "shelf_label",
      workflow: "shelf_edge",
      product: product as PrintableProduct,
      extraVars: { price: formatCurrency(product.unit_price ?? 0) },
    });

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
        // ADR-0110 — enrolment goes through the identity service so the
        // primary flip and code-clash checks happen in one transaction.
        for (let i = 0; i < codes.length; i++) {
          await writeIdentifier({
            businessId: currentBusiness.id,
            productId: created.id,
            code: codes[i],
            kind: "gtin",
            isPrimary: i === 0,
            source: "import",
          });
        }
      }
    }
  };

  const handleImportComplete = () => {
    // Reset resolver cache so next import starts fresh
    categoryResolverRef.current = null;
  };
  const [viewingProduct, setViewingProduct] = useState<Product | null>(null);
  const [showDetailDialog, setShowDetailDialog] = useState(false);
  const dismissedSelectedProductRef = useRef<string | null>(null);
  // Re-entry guard for page-level scan-to-onboard. The ref is the actual
  // guard (synchronous, race-proof); the state drives the router-active
  // gate + a "Looking up barcode…" toast so the operator gets immediate
  // feedback during the resolve_product_identity RPC.
  const resolvingScanRef = useRef(false);
  const [isResolvingScan, setIsResolvingScan] = useState(false);

  // Handle ?action=create from global create menu OR ?createWithCode=... from POS
  // unknown-barcode recovery. Both now navigate to the routed create page
  // (RecordFormShell) rather than opening a legacy inline dialog.
  useEffect(() => {
    const action = searchParams.get("action");
    const createWithCode = searchParams.get("createWithCode");
    if (action === "create" || createWithCode) {
      const cleanReturnParams = new URLSearchParams(searchParams);
      cleanReturnParams.delete("action");
      cleanReturnParams.delete("createWithCode");
      const cleanReturnSearch = cleanReturnParams.toString();
      const returnTo = `/inventory-app/products${cleanReturnSearch ? `?${cleanReturnSearch}` : ""}`;
      navigate(
        createWithCode
          ? `/inventory-app/products/new?createWithCode=${encodeURIComponent(createWithCode)}&returnTo=${encodeURIComponent(returnTo)}`
          : `/inventory-app/products/new?returnTo=${encodeURIComponent(returnTo)}`,
        { replace: true },
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // Handle ?selected=productId to auto-open product detail
  useEffect(() => {
    const selectedId = searchParams.get("selected");
    if (!selectedId) {
      dismissedSelectedProductRef.current = null;
      return;
    }
    if (dismissedSelectedProductRef.current === selectedId) return;
    if (selectedId && products.length > 0 && !showDetailDialog) {
      const found = products.find(p => p.id === selectedId);
      if (found) {
        dismissedSelectedProductRef.current = null;
        setViewingProduct(found);
        setShowDetailDialog(true);
      }
    }
  }, [searchParams, products, showDetailDialog]);

  const handleDetailOpenChange = useCallback(
    (open: boolean) => {
      setShowDetailDialog(open);
      if (open) return;
      dismissedSelectedProductRef.current = searchParams.get("selected");
      setViewingProduct(null);
      if (!searchParams.has("selected")) return;
      const next = new URLSearchParams(searchParams);
      next.delete("selected");
      setSearchParams(next, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  // Scan-to-onboard: page-level scan target at priority 5 so any focused
  // <BarcodeInputField> (priority 10) still wins. Resolves the code via
  // resolve_product_identity — hit opens the product detail dialog, miss
  // navigates to /products/new with the barcode prefilled.
  useScanTarget({
    active: !!currentBusiness?.id && !showDetailDialog && !isResolvingScan,
    priority: 5,
    label: "ProductsPage scan-to-onboard",
    onScan: async (e) => {
      if (resolvingScanRef.current) return;
      const code = e.code.replace(/[\x00-\x1F\x7F]/g, "").trim();
      if (!code || !currentBusiness?.id) return;
      resolvingScanRef.current = true;
      setIsResolvingScan(true);
      const loadingToast = toast({
        title: "Looking up barcode…",
        description: code,
      });
      try {
        const decision = await resolveProductIdentityOnce({
          businessId: currentBusiness.id,
          branchId: currentBranch?.id ?? null,
          code,
        });
        if (decision.kind === "error") throw decision.err;
        const row =
          decision.kind === "resolved"
            ? { product_id: decision.identity.productId, product_name: decision.identity.productName }
            : null;
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
          toast({ title: `Found: ${row.product_name}` });
        } else if (decision.kind === "not_found") {
          playPOSSound("low_stock_warning");
          navigate(`/inventory-app/products/new?createWithCode=${encodeURIComponent(code)}`);
          toast({ title: "New barcode", description: "Fill in product details to onboard." });
        } else {
          // Registered, but not usable: ambiguous / inactive / archived /
          // expired / another tenant. Never offer "create a new product" —
          // that is how duplicate masters get born. Copy comes from the
          // shared taxonomy, never from RPC detail.
          playPOSSound("error");
          const copy = describeResolution(decision, code);
          toast({ title: copy.title, description: copy.detail, variant: "destructive" });
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

  const openCreate = () => navigate("/inventory-app/products/new");
  const openEdit = (product: Product) => navigate(`/inventory-app/products/${product.id}/edit`);



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
                <Button onClick={() => openCreate()} className="flex-1 sm:flex-none">
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
          <PrintFilteredLabelsButton
            search={searchQuery}
            categoryId={categoryFilter}
            matchCount={pagination.totalCount}
            disabled={!currentBusiness}
          />
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
                                    baseLabel={productBaseLabelOrUnset(product as any)}
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
                              <DropdownMenuItem onClick={() => openEdit(product)}>
                                <Pencil className="mr-2 h-4 w-4" />
                                Edit
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => handlePrintLabel(product)}>
                                <Printer className="mr-2 h-4 w-4" />
                                Print label
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => handlePrintShelfLabel(product)}>
                                <Printer className="mr-2 h-4 w-4" />
                                Print shelf label
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

        {/* Add/Edit surface is now the routed RecordFormShell at
            /inventory-app/products/{new,:id/edit}. See ProductForm.tsx. */}


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
          onOpenChange={handleDetailOpenChange}
          onEdit={(id) => {
            const p = products.find((x) => x.id === id);
            if (p) openEdit(p);
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
