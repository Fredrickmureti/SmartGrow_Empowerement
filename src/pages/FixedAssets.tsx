import { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ConfirmDeleteDialog, useConfirmDelete } from "@/components/shared/ConfirmDeleteDialog";
import { useFixedAssets, FixedAsset } from "@/hooks/useFixedAssets";
import { useCurrency } from "@/hooks/useCurrency";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import {
  Plus,
  Search,
  Loader2,
  Building,
  MoreHorizontal,
  Pencil,
  Trash2,
  TrendingDown,
  DollarSign,
  Package,
  Calculator,
  Eye,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { format } from "date-fns";
import { useSubscriptionAccess } from "@/contexts/SubscriptionAccessContext";
import { PrintLabelButton } from "@/components/labels/PrintLabelButton";
import { FinanceScopeBadge } from "@/components/finance/FinanceScopeBadge";
import { useFinancePermission } from "@/hooks/finance/useFinancePermission";
import { useToast } from "@/hooks/use-toast";
import { normalizeError } from "@/services/resilience";
// Asset create/edit are dedicated routes now:
//   /finance/fixed-assets/new  and  /finance/fixed-assets/:id/edit
// Peek moved to PeekScaffold behind `?peek=<id>`.
import { AssetPeekSheet } from "@/features/finance/fixed-assets/AssetPeekSheet";
import { AssetCategorySheet } from "@/features/finance/fixed-assets/AssetCategorySheet";
import { DisposeAssetSheet } from "@/features/finance/fixed-assets/DisposeAssetSheet";
import { DepreciationRunSheet } from "@/features/finance/fixed-assets/DepreciationRunSheet";

export default function FixedAssets() {
  const navigate = useNavigate();
  const { assets, isLoading, deleteAsset } = useFixedAssets();
  const { formatCurrency, isReady: currencyReady } = useCurrency();
  const { toast } = useToast();
  const { isReadOnly, openUpgradeModal } = useSubscriptionAccess();
  const { allowed: canManageAssets } = useFinancePermission("finance.manage_assets");

  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("active");

  // URL-driven UI state.
  //   ?sheet=category|dispose|depreciation  → auxiliary sheets
  //   ?peek=<uuid>                          → canonical peek surface
  // Create/edit are dedicated routes (/finance/fixed-assets/new + /:id/edit).
  const [searchParams, setSearchParams] = useSearchParams();
  const sheetKind = searchParams.get("sheet");
  const sheetId = searchParams.get("id");
  const peekId = searchParams.get("peek");


  const openSheet = (
    kind: "category" | "dispose" | "depreciation",
    id?: string,
  ) => {
    const next = new URLSearchParams(searchParams);
    next.set("sheet", kind);
    if (id) next.set("id", id);
    else next.delete("id");
    setSearchParams(next, { replace: false });
  };
  const closeSheet = () => {
    const next = new URLSearchParams(searchParams);
    next.delete("sheet");
    next.delete("id");
    setSearchParams(next, { replace: false });
  };
  const setPeek = (id: string | null) => {
    const next = new URLSearchParams(searchParams);
    if (id) next.set("peek", id);
    else next.delete("peek");
    setSearchParams(next, { replace: false });
  };

  const disposingAsset = useMemo<FixedAsset | null>(
    () =>
      sheetKind === "dispose" && sheetId
        ? assets.find((a) => a.id === sheetId) ?? null
        : null,
    [sheetKind, sheetId, assets],
  );

  const openAssetCreate = () => {
    if (isReadOnly) {
      openUpgradeModal("fixed_assets");
      return;
    }
    navigate("/finance/fixed-assets/new");
  };
  const openAssetEdit = (asset: FixedAsset) => {
    if (isReadOnly) {
      openUpgradeModal("fixed_assets");
      return;
    }
    navigate(`/finance/fixed-assets/${asset.id}/edit`);
  };
  const openCategorySheet = () => {
    if (isReadOnly) {
      openUpgradeModal("fixed_assets");
      return;
    }
    openSheet("category");
  };
  const openDisposeSheet = (asset: FixedAsset) => {
    if (isReadOnly) {
      openUpgradeModal("fixed_assets");
      return;
    }
    openSheet("dispose", asset.id);
  };

  const executeDeleteAsset = async (asset: FixedAsset) => {
    try {
      await deleteAsset(asset.id);
      toast({ title: "Asset deleted" });
    } catch (error) {
      toast({
        title: "Error deleting asset",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    }
  };
  const deleteConfirm = useConfirmDelete<FixedAsset>({ onConfirm: executeDeleteAsset });
  const handleDelete = (asset: FixedAsset) => {
    if (isReadOnly) {
      openUpgradeModal("fixed_assets");
      return;
    }
    deleteConfirm.requestDelete(asset);
  };

  const filteredAssets = assets.filter((asset) => {
    const matchesSearch =
      asset.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      asset.asset_number.toLowerCase().includes(searchQuery.toLowerCase()) ||
      asset.serial_number?.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesStatus =
      statusFilter === "all" || asset.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const activeAssets = assets.filter((a) => a.status === "active");
  // Assets can be acquired in different currencies, so the only valid sum is
  // over the server-stamped base-currency cost. Never add transaction amounts.
  const totalValue = activeAssets.reduce(
    (sum, a) => sum + Number(a.base_purchase_price ?? a.purchase_price),
    0,
  );
  const totalDepreciation = activeAssets.reduce(
    (sum, a) => sum + (a.accumulated_depreciation || 0),
    0,
  );
  const totalBookValue = activeAssets.reduce(
    (sum, a) => sum + (a.book_value || 0),
    0,
  );

  const getStatusBadge = (status: string) => {
    const styles: Record<string, string> = {
      active: "bg-primary/10 text-primary",
      disposed: "bg-muted text-muted-foreground",
      written_off: "bg-destructive/10 text-destructive",
    };
    return (
      <Badge className={styles[status] || styles.active}>
        {status.replace("_", " ")}
      </Badge>
    );
  };

  return (
    <>
      <div className="space-y-4 sm:space-y-6">
        <div className="page-header flex-col sm:flex-row gap-4">
          <div className="flex items-center gap-2">
            <div>
              <h1 className="page-title">Fixed Assets</h1>
              <p className="text-sm sm:text-base text-muted-foreground">
                Track and manage company assets with depreciation
              </p>
              <div className="mt-2">
                <FinanceScopeBadge />
              </div>
            </div>
            <RefreshButton
              queryKeyPrefixes={[
                ["fixed-assets"] as const,
                ["depreciation-schedules"] as const,
              ]}
              tooltip="Refresh fixed assets"
            />
          </div>
          <div className="flex flex-wrap gap-2 w-full sm:w-auto">
            {canManageAssets && (
              <>
                <Button
                  variant="outline"
                  onClick={() => openSheet("depreciation")}
                >
                  <Calculator className="mr-2 h-4 w-4" />
                  Run Depreciation
                </Button>
                <Button variant="outline" onClick={openCategorySheet}>
                  <Plus className="mr-2 h-4 w-4" />
                  Add Category
                </Button>
                <Button onClick={openAssetCreate}>
                  <Plus className="mr-2 h-4 w-4" />
                  Add Asset
                </Button>
              </>
            )}
          </div>
        </div>

        {/* Stats */}
        <div className="stats-grid grid-cols-1 sm:grid-cols-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Assets</CardTitle>
              <Package className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{activeAssets.length}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Original Value</CardTitle>
              <DollarSign className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{formatCurrency(totalValue)}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Depreciation</CardTitle>
              <TrendingDown className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {formatCurrency(totalDepreciation)}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Book Value</CardTitle>
              <Building className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {formatCurrency(totalBookValue)}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Filters */}
        <div className="filter-bar">
          <div className="relative flex-1 min-w-0">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search assets..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10 w-full"
            />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-full sm:w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Status</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="disposed">Disposed</SelectItem>
              <SelectItem value="written_off">Written Off</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Table */}
        <Card>
          <CardContent className="p-0">
            {isLoading || !currencyReady ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            ) : filteredAssets.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <Building className="h-12 w-12 text-muted-foreground mb-4" />
                <h3 className="text-lg font-medium">No assets found</h3>
                <p className="text-muted-foreground">
                  {assets.length === 0
                    ? "Start by adding your first asset."
                    : "Try adjusting your search or filter."}
                </p>
              </div>
            ) : (
              <div className="table-container">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Asset #</TableHead>
                      <TableHead>Name</TableHead>
                      <TableHead>Category</TableHead>
                      <TableHead>Purchase Date</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Purchase Price</TableHead>
                      <TableHead className="text-right">Book Value</TableHead>
                      <TableHead className="w-12"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredAssets.map((asset) => (
                      <TableRow key={asset.id}>
                        <TableCell className="font-medium">
                          {asset.asset_number}
                        </TableCell>
                        <TableCell>
                          <div>
                            <div className="font-medium">{asset.name}</div>
                            {asset.serial_number && (
                              <div className="text-sm text-muted-foreground">
                                S/N: {asset.serial_number}
                              </div>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>{asset.category?.name || "—"}</TableCell>
                        <TableCell>
                          {format(new Date(asset.purchase_date), "MMM d, yyyy")}
                        </TableCell>
                        <TableCell>{getStatusBadge(asset.status)}</TableCell>
                        <TableCell className="text-right">
                          {formatCurrency(asset.purchase_price, asset.currency)}
                          {asset.currency &&
                            asset.currency !== baseCurrency && (
                              <div className="text-xs text-muted-foreground">
                                {formatCurrency(
                                  Number(
                                    asset.base_purchase_price ??
                                      asset.purchase_price,
                                  ),
                                )}{" "}
                                @ {asset.acquisition_exchange_rate}
                              </div>
                            )}
                        </TableCell>
                        <TableCell className="text-right font-medium">
                          {formatCurrency(asset.book_value || 0)}
                        </TableCell>
                        <TableCell>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon">
                                <MoreHorizontal className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              {canManageAssets && (
                                <DropdownMenuItem
                                  onClick={() => openAssetEdit(asset)}
                                >
                                  <Pencil className="mr-2 h-4 w-4" />
                                  Edit
                                </DropdownMenuItem>
                              )}
                              <DropdownMenuItem
                                onClick={() => setPeek(asset.id)}
                              >
                                <Eye className="mr-2 h-4 w-4" />
                                View Details
                              </DropdownMenuItem>
                              {/* Wave 21 — canonical asset-tag print seam.
                                * Routes through `useLabelPrint` →
                                * `printLabelByTemplate` → dispatcher
                                * (ADR-0086 / ADR-0090). Uses the
                                * `asset_label` template seeded by
                                * `seed_default_label_templates`. */}
                              <DropdownMenuItem asChild>
                                <PrintLabelButton
                                  variant="ghost"
                                  size="sm"
                                  className="w-full justify-start font-normal px-2 h-8"
                                  label="Print Asset Tag"
                                  templateKey="asset_label"
                                  workflow="asset_tag"
                                  product={{
                                    id: asset.id,
                                    name: asset.name,
                                    sku: asset.asset_number,
                                    barcode: asset.asset_number,
                                  }}
                                  sourceDocType="fixed_asset"
                                  sourceDocId={asset.id}
                                  extraVars={{
                                    asset_number: asset.asset_number,
                                    category: asset.category?.name ?? "",
                                    acquisition_date: asset.purchase_date ?? "",
                                  }}
                                />
                              </DropdownMenuItem>
                              {canManageAssets && asset.status === "active" && (
                                <DropdownMenuItem
                                  onClick={() => openDisposeSheet(asset)}
                                >
                                  <TrendingDown className="mr-2 h-4 w-4" />
                                  Dispose
                                </DropdownMenuItem>
                              )}
                              {canManageAssets && (
                                <DropdownMenuItem
                                  onClick={() => handleDelete(asset)}
                                  className="text-destructive"
                                >
                                  <Trash2 className="mr-2 h-4 w-4" />
                                  Delete
                                </DropdownMenuItem>
                              )}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>

        <ConfirmDeleteDialog
          open={deleteConfirm.isOpen}
          onOpenChange={deleteConfirm.setIsOpen}
          title="Delete Asset"
          itemName={deleteConfirm.itemToDelete?.name}
          onConfirm={deleteConfirm.confirmDelete}
          isLoading={deleteConfirm.isDeleting}
        />
      </div>

      {/* Enterprise UX: create/edit are dedicated routes; peek is on
          PeekScaffold. Category / dispose / depreciation are still
          DetailSheet-based auxiliary flows. */}
      <AssetCategorySheet
        open={sheetKind === "category"}
        onOpenChange={(o) => (o ? openSheet("category") : closeSheet())}
      />
      <DisposeAssetSheet
        open={sheetKind === "dispose"}
        onOpenChange={(o) => (o ? openSheet("dispose", sheetId ?? undefined) : closeSheet())}
        asset={disposingAsset}
      />
      <DepreciationRunSheet
        open={sheetKind === "depreciation"}
        onOpenChange={(o) => (o ? openSheet("depreciation") : closeSheet())}
      />
      <AssetPeekSheet
        assetId={peekId}
        onOpenChange={(o) => { if (!o) setPeek(null); }}
      />
    </>
  );
}
