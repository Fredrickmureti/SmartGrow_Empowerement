import { useState } from "react";
import { ConfirmDeleteDialog, useConfirmDelete } from "@/components/shared/ConfirmDeleteDialog";
import { useFixedAssets, FixedAsset, AssetCategory } from "@/hooks/useFixedAssets";
import { useDepreciationRun, DepreciationPreviewItem } from "@/hooks/useDepreciationRun";
import { useAccounts } from "@/hooks/useAccounts";
import { useCurrency } from "@/hooks/useCurrency";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { queryKeys } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
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
import {
  Plus,
  Search,
  Loader2,
  Building,
  Car,
  Monitor,
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
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import { AssetDepreciationHistory } from "@/components/finance/AssetDepreciationHistory";
import { useSubscriptionAccess } from "@/contexts/SubscriptionAccessContext";
import { usePermissions } from "@/hooks/usePermissions";
import { FinanceScopeBadge } from "@/components/finance/FinanceScopeBadge";
import { useFinancePermission } from "@/hooks/finance/useFinancePermission";
import { normalizeError } from "@/services/resilience";

export default function FixedAssets() {
  const {
    assets,
    categories,
    isLoading,
    createAsset,
    updateAsset,
    deleteAsset,
    createCategory,
    disposeAsset,
  } = useFixedAssets();
  const { previewDepreciation, runDepreciation, isRunning, isPreviewing } = useDepreciationRun();
  const { accounts: allAccounts } = useAccounts();
  const { formatCurrency, isReady: currencyReady } = useCurrency();
  const { toast } = useToast();
  const { isReadOnly, openUpgradeModal } = useSubscriptionAccess();
  const { canManageFinancials } = usePermissions();
  const { allowed: canManageAssets } = useFinancePermission("finance.manage_assets");
  const [showDialog, setShowDialog] = useState(false);
  const [showCategoryDialog, setShowCategoryDialog] = useState(false);
  const [showDisposeDialog, setShowDisposeDialog] = useState(false);
  const [showDepreciationDialog, setShowDepreciationDialog] = useState(false);
  const [depreciationPreview, setDepreciationPreview] = useState<DepreciationPreviewItem[]>([]);
  const [depreciationPeriod, setDepreciationPeriod] = useState(format(new Date(), "yyyy-MM"));
  const [editingAsset, setEditingAsset] = useState<FixedAsset | null>(null);
  const [disposingAsset, setDisposingAsset] = useState<FixedAsset | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("active");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showAssetDetailDialog, setShowAssetDetailDialog] = useState(false);

  const [formData, setFormData] = useState({
    name: "",
    description: "",
    category_id: "",
    purchase_date: format(new Date(), "yyyy-MM-dd"),
    purchase_price: 0,
    residual_value: 0,
    useful_life_years: 5,
    depreciation_method: "straight_line",
    serial_number: "",
    location: "",
    vendor_id: "",
  });

  const [categoryForm, setCategoryForm] = useState({
    name: "",
    description: "",
    depreciation_method: "straight_line",
    useful_life_years: 5,
    depreciation_rate: 20,
    asset_account_id: "",
    depreciation_account_id: "",
    accumulated_depreciation_account_id: "",
    gain_loss_account_id: "",
  });

  const [disposeForm, setDisposeForm] = useState({
    disposal_date: format(new Date(), "yyyy-MM-dd"),
    disposal_amount: 0,
    disposal_method: "sale",
    notes: "",
  });

  const resetForm = () => {
    setFormData({
      name: "",
      description: "",
      category_id: "",
      purchase_date: format(new Date(), "yyyy-MM-dd"),
      purchase_price: 0,
      residual_value: 0,
      useful_life_years: 5,
      depreciation_method: "straight_line",
      serial_number: "",
      location: "",
      vendor_id: "",
    });
    setEditingAsset(null);
  };

  const handleOpenDialog = (asset?: FixedAsset) => {
    if (isReadOnly) {
      openUpgradeModal("fixed_assets");
      return;
    }
    if (asset) {
      setEditingAsset(asset);
      setFormData({
        name: asset.name,
        description: asset.description || "",
        category_id: asset.category_id || "",
        purchase_date: asset.purchase_date,
        purchase_price: asset.purchase_price,
        residual_value: asset.residual_value || 0,
        useful_life_years: asset.useful_life_years || 5,
        depreciation_method: asset.depreciation_method || "straight_line",
        serial_number: asset.serial_number || "",
        location: asset.location || "",
        vendor_id: asset.vendor_id || "",
      });
    } else {
      resetForm();
    }
    setShowDialog(true);
  };

  const handleOpenDisposeDialog = (asset: FixedAsset) => {
    if (isReadOnly) {
      openUpgradeModal("fixed_assets");
      return;
    }
    setDisposingAsset(asset);
    setDisposeForm({
      disposal_date: format(new Date(), "yyyy-MM-dd"),
      disposal_amount: asset.book_value || 0,
      disposal_method: "sale",
      notes: "",
    });
    setShowDisposeDialog(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);

    try {
      if (editingAsset) {
        await updateAsset(editingAsset.id, {
          name: formData.name,
          description: formData.description || null,
          category_id: formData.category_id || null,
          purchase_date: formData.purchase_date,
          purchase_price: formData.purchase_price,
          residual_value: formData.residual_value,
          useful_life_years: formData.useful_life_years,
          depreciation_method: formData.depreciation_method,
          serial_number: formData.serial_number || null,
          location: formData.location || null,
          vendor_id: formData.vendor_id || null,
        });
        toast({ title: "Asset updated successfully" });
      } else {
        await createAsset({
          name: formData.name,
          description: formData.description || null,
          category_id: formData.category_id || null,
          purchase_date: formData.purchase_date,
          purchase_price: formData.purchase_price,
          residual_value: formData.residual_value,
          useful_life_years: formData.useful_life_years,
          depreciation_method: formData.depreciation_method,
          serial_number: formData.serial_number || null,
          location: formData.location || null,
          vendor_id: formData.vendor_id || null,
          invoice_reference: null,
          branch_id: null,
          assigned_to: null,
          depreciation_start_date: null,
          accumulated_depreciation: 0,
          book_value: formData.purchase_price,
          status: "active",
          disposal_date: null,
          disposal_price: null,
          disposal_reason: null,
          barcode: null,
          insurance_value: null,
          insurance_policy: null,
          insurance_expiry: null,
          warranty_expiry: null,
          notes: null,
        });
        toast({ title: "Asset created successfully" });
      }
      setShowDialog(false);
      resetForm();
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

  const handleCreateCategory = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);

    try {
      await createCategory({
        name: categoryForm.name,
        description: categoryForm.description || null,
        depreciation_method: categoryForm.depreciation_method,
        useful_life_years: categoryForm.useful_life_years,
        depreciation_rate: categoryForm.depreciation_rate,
        asset_account_id: categoryForm.asset_account_id || null,
        depreciation_account_id: categoryForm.depreciation_account_id || null,
        accumulated_depreciation_account_id: categoryForm.accumulated_depreciation_account_id || null,
        gain_loss_account_id: categoryForm.gain_loss_account_id || null,
        is_active: true,
      });
      toast({ title: "Category created successfully" });
      setShowCategoryDialog(false);
      setCategoryForm({
        name: "",
        description: "",
        depreciation_method: "straight_line",
        useful_life_years: 5,
        depreciation_rate: 20,
        asset_account_id: "",
        depreciation_account_id: "",
        accumulated_depreciation_account_id: "",
        gain_loss_account_id: "",
      });
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

  const handleDispose = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!disposingAsset) return;
    setIsSubmitting(true);

    try {
      await disposeAsset(
        disposingAsset.id,
        disposeForm.disposal_date,
        disposeForm.disposal_amount,
        disposeForm.disposal_method
      );
      toast({ title: "Asset disposed successfully" });
      setShowDisposeDialog(false);
      setDisposingAsset(null);
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

  const executeDeleteAsset = async (asset: FixedAsset) => {
    try {
      await deleteAsset(asset.id);
      toast({ title: "Asset deleted" });
    } catch (error: any) {
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
  const totalValue = activeAssets.reduce((sum, a) => sum + a.purchase_price, 0);
  const totalDepreciation = activeAssets.reduce(
    (sum, a) => sum + (a.accumulated_depreciation || 0),
    0
  );
  const totalBookValue = activeAssets.reduce((sum, a) => sum + (a.book_value || 0), 0);

  const getStatusBadge = (status: string) => {
    const styles: Record<string, string> = {
      active: "bg-primary/10 text-primary",
      disposed: "bg-muted text-muted-foreground",
      written_off: "bg-destructive/10 text-destructive",
    };
    return <Badge className={styles[status] || styles.active}>{status.replace("_", " ")}</Badge>;
  };

  const handleOpenDepreciationDialog = async () => {
    setShowDepreciationDialog(true);
    try {
      const preview = await previewDepreciation(depreciationPeriod + "-01");
      setDepreciationPreview(preview);
    } catch (err: any) {
      toast({ title: "Error", description: normalizeError(err).message, variant: "destructive" });
    }
  };

  const handleRunDepreciation = async () => {
    try {
      const result = await runDepreciation(depreciationPeriod + "-01");
      if (result.errors.length > 0) {
        toast({ title: "Depreciation completed with warnings", description: result.errors[0], variant: "destructive" });
      }
      setShowDepreciationDialog(false);
    } catch (err: any) {
      toast({ title: "Error", description: normalizeError(err).message, variant: "destructive" });
    }
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
              <div className="mt-2"><FinanceScopeBadge /></div>
            </div>
            <RefreshButton
              queryKeyPrefixes={[
                ['fixed-assets'] as const,
                ['depreciation-schedules'] as const,
              ]}
              tooltip="Refresh fixed assets"
            />
          </div>
          <div className="flex flex-wrap gap-2 w-full sm:w-auto">
            {canManageAssets && (
              <>
                <Button variant="outline" onClick={handleOpenDepreciationDialog} disabled={isPreviewing}>
                  {isPreviewing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Calculator className="mr-2 h-4 w-4" />}
                  Run Depreciation
                </Button>
                <Button variant="outline" onClick={() => {
                  if (isReadOnly) { openUpgradeModal("fixed_assets"); return; }
                  setShowCategoryDialog(true);
                }}>
                  <Plus className="mr-2 h-4 w-4" />
                  Add Category
                </Button>
                <Button onClick={() => handleOpenDialog()}>
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
              <div className="text-2xl font-bold">{formatCurrency(totalDepreciation)}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Book Value</CardTitle>
              <Building className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{formatCurrency(totalBookValue)}</div>
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
            {(isLoading || !currencyReady) ? (
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
                          {formatCurrency(asset.purchase_price)}
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
                                <DropdownMenuItem onClick={() => handleOpenDialog(asset)}>
                                  <Pencil className="mr-2 h-4 w-4" />
                                  Edit
                                </DropdownMenuItem>
                              )}
                              <DropdownMenuItem onClick={() => { setEditingAsset(asset); setShowAssetDetailDialog(true); }}>
                                <Eye className="mr-2 h-4 w-4" />
                                View Details
                              </DropdownMenuItem>
                              {canManageAssets && asset.status === "active" && (
                                <DropdownMenuItem
                                  onClick={() => handleOpenDisposeDialog(asset)}
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

        {/* Add/Edit Asset Dialog */}
        <Dialog open={showDialog} onOpenChange={setShowDialog}>
          <DialogContent className="max-w-lg max-h-[90vh]">
            <DialogHeader>
              <DialogTitle>
                {editingAsset ? "Edit Asset" : "Add New Asset"}
              </DialogTitle>
              <DialogDescription>
                {editingAsset
                  ? "Update the asset details."
                  : "Enter the asset information below."}
              </DialogDescription>
            </DialogHeader>

            <ScrollArea className="max-h-[calc(90vh-180px)] pr-4">
              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2 md:col-span-2">
                    <Label htmlFor="name">Name *</Label>
                    <Input
                      id="name"
                      value={formData.name}
                      onChange={(e) =>
                        setFormData({ ...formData, name: e.target.value })
                      }
                      required
                    />
                  </div>
                  <div className="space-y-2 md:col-span-2">
                    <Label htmlFor="description">Description</Label>
                    <Textarea
                      id="description"
                      value={formData.description}
                      onChange={(e) =>
                        setFormData({ ...formData, description: e.target.value })
                      }
                      rows={2}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="category_id">Category</Label>
                    <Select
                      value={formData.category_id}
                      onValueChange={(value) =>
                        setFormData({ ...formData, category_id: value })
                      }
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select category" />
                      </SelectTrigger>
                      <SelectContent>
                        {categories.map((cat) => (
                          <SelectItem key={cat.id} value={cat.id}>
                            {cat.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="serial_number">Serial Number</Label>
                    <Input
                      id="serial_number"
                      value={formData.serial_number}
                      onChange={(e) =>
                        setFormData({ ...formData, serial_number: e.target.value })
                      }
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="purchase_date">Purchase Date *</Label>
                    <Input
                      id="purchase_date"
                      type="date"
                      value={formData.purchase_date}
                      onChange={(e) =>
                        setFormData({ ...formData, purchase_date: e.target.value })
                      }
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="purchase_price">Purchase Price *</Label>
                    <Input
                      id="purchase_price"
                      type="number"
                      min="0"
                      step="0.01"
                      value={formData.purchase_price}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          purchase_price: parseFloat(e.target.value) || 0,
                        })
                      }
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="residual_value">Residual Value</Label>
                    <Input
                      id="residual_value"
                      type="number"
                      min="0"
                      step="0.01"
                      value={formData.residual_value}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          residual_value: parseFloat(e.target.value) || 0,
                        })
                      }
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="useful_life_years">Useful Life (Years)</Label>
                    <Input
                      id="useful_life_years"
                      type="number"
                      min="1"
                      value={formData.useful_life_years}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          useful_life_years: parseInt(e.target.value) || 5,
                        })
                      }
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="depreciation_method">Depreciation Method</Label>
                    <Select
                      value={formData.depreciation_method}
                      onValueChange={(value) =>
                        setFormData({ ...formData, depreciation_method: value })
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="straight_line">Straight Line</SelectItem>
                        <SelectItem value="reducing_balance">Reducing Balance</SelectItem>
                        <SelectItem value="units_of_production">Units of Production</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="location">Location</Label>
                    <Input
                      id="location"
                      value={formData.location}
                      onChange={(e) =>
                        setFormData({ ...formData, location: e.target.value })
                      }
                    />
                  </div>
                </div>

                <div className="flex justify-end gap-2 pt-4">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setShowDialog(false)}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" disabled={isSubmitting}>
                    {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    {editingAsset ? "Update" : "Create"}
                  </Button>
                </div>
              </form>
            </ScrollArea>
          </DialogContent>
        </Dialog>

        {/* Add Category Dialog */}
        <Dialog open={showCategoryDialog} onOpenChange={setShowCategoryDialog}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add Asset Category</DialogTitle>
              <DialogDescription>
                Create a new category for your assets.
              </DialogDescription>
            </DialogHeader>

            <form onSubmit={handleCreateCategory} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="cat_name">Name *</Label>
                <Input
                  id="cat_name"
                  value={categoryForm.name}
                  onChange={(e) =>
                    setCategoryForm({ ...categoryForm, name: e.target.value })
                  }
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="cat_description">Description</Label>
                <Input
                  id="cat_description"
                  value={categoryForm.description}
                  onChange={(e) =>
                    setCategoryForm({ ...categoryForm, description: e.target.value })
                  }
                />
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="cat_method">Depreciation Method</Label>
                  <Select
                    value={categoryForm.depreciation_method}
                    onValueChange={(value) =>
                      setCategoryForm({ ...categoryForm, depreciation_method: value })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="straight_line">Straight Line</SelectItem>
                      <SelectItem value="reducing_balance">Reducing Balance</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="cat_life">Useful Life (Years)</Label>
                  <Input
                    id="cat_life"
                    type="number"
                    min="1"
                    value={categoryForm.useful_life_years}
                    onChange={(e) =>
                      setCategoryForm({
                        ...categoryForm,
                        useful_life_years: parseInt(e.target.value) || 5,
                      })
                    }
                  />
                </div>
              </div>

              <Separator className="my-2" />
              <p className="text-sm font-medium">GL Account Mappings</p>
              <div className="grid gap-4 md:grid-cols-2">
                {[
                  { key: "asset_account_id", label: "Asset Account", type: "asset" },
                  { key: "depreciation_account_id", label: "Depreciation Expense", type: "expense" },
                  { key: "accumulated_depreciation_account_id", label: "Accumulated Depreciation", type: "asset" },
                  { key: "gain_loss_account_id", label: "Gain/Loss on Disposal", type: "expense" },
                ].map(({ key, label, type }) => (
                  <div key={key} className="space-y-2">
                    <Label>{label}</Label>
                    <Select
                      value={(categoryForm as any)[key] || ""}
                      onValueChange={(v) => setCategoryForm({ ...categoryForm, [key]: v })}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder={`Select ${label.toLowerCase()}`} />
                      </SelectTrigger>
                      <SelectContent>
                        {allAccounts.filter(a => a.account_type === type && a.is_active).map(a => (
                          <SelectItem key={a.id} value={a.id}>{a.code} — {a.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ))}
              </div>

              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setShowCategoryDialog(false)}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={isSubmitting}>
                  {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Create Category
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>

        {/* Dispose Asset Dialog */}
        <Dialog open={showDisposeDialog} onOpenChange={setShowDisposeDialog}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Dispose Asset</DialogTitle>
              <DialogDescription>
                Record the disposal of {disposingAsset?.name}
              </DialogDescription>
            </DialogHeader>

            <form onSubmit={handleDispose} className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="disposal_date">Disposal Date *</Label>
                  <Input
                    id="disposal_date"
                    type="date"
                    value={disposeForm.disposal_date}
                    onChange={(e) =>
                      setDisposeForm({ ...disposeForm, disposal_date: e.target.value })
                    }
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="disposal_amount">Disposal Amount</Label>
                  <Input
                    id="disposal_amount"
                    type="number"
                    min="0"
                    step="0.01"
                    value={disposeForm.disposal_amount}
                    onChange={(e) =>
                      setDisposeForm({
                        ...disposeForm,
                        disposal_amount: parseFloat(e.target.value) || 0,
                      })
                    }
                  />
                </div>
                <div className="space-y-2 md:col-span-2">
                  <Label htmlFor="disposal_method">Disposal Method</Label>
                  <Select
                    value={disposeForm.disposal_method}
                    onValueChange={(value) =>
                      setDisposeForm({ ...disposeForm, disposal_method: value })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="sale">Sale</SelectItem>
                      <SelectItem value="scrap">Scrap</SelectItem>
                      <SelectItem value="donation">Donation</SelectItem>
                      <SelectItem value="theft">Theft/Loss</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2 md:col-span-2">
                  <Label htmlFor="disposal_notes">Notes</Label>
                  <Textarea
                    id="disposal_notes"
                    value={disposeForm.notes}
                    onChange={(e) =>
                      setDisposeForm({ ...disposeForm, notes: e.target.value })
                    }
                    rows={2}
                  />
                </div>
              </div>

              {disposingAsset && (
                <Card className="bg-muted/50">
                  <CardContent className="p-4 text-sm">
                    <div className="flex justify-between">
                      <span>Book Value:</span>
                      <span className="font-medium">
                        {formatCurrency(disposingAsset.book_value || 0)}
                      </span>
                    </div>
                    <div className="flex justify-between mt-1">
                      <span>Gain/Loss:</span>
                      <span
                        className={
                          disposeForm.disposal_amount - (disposingAsset.book_value || 0) >= 0
                            ? "text-green-600 font-medium"
                            : "text-red-600 font-medium"
                        }
                      >
                        {formatCurrency(
                          disposeForm.disposal_amount - (disposingAsset.book_value || 0)
                        )}
                      </span>
                    </div>
                  </CardContent>
                </Card>
              )}

              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setShowDisposeDialog(false)}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={isSubmitting}>
                  {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Dispose Asset
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>

        {/* Run Depreciation Dialog */}
        <Dialog open={showDepreciationDialog} onOpenChange={setShowDepreciationDialog}>
          <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Run Depreciation</DialogTitle>
              <DialogDescription>
                Post monthly depreciation entries for all active assets.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Period</Label>
                <Input
                  type="month"
                  value={depreciationPeriod}
                  onChange={(e) => setDepreciationPeriod(e.target.value)}
                />
              </div>
              <Button variant="outline" size="sm" onClick={async () => {
                try {
                  const preview = await previewDepreciation(depreciationPeriod + "-01");
                  setDepreciationPreview(preview);
                } catch (err: any) {
                  toast({ title: "Error", description: normalizeError(err).message, variant: "destructive" });
                }
              }} disabled={isPreviewing}>
                {isPreviewing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Preview
              </Button>

              {depreciationPreview.length > 0 && (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Asset</TableHead>
                      <TableHead>Method</TableHead>
                      <TableHead className="text-right">Book Value</TableHead>
                      <TableHead className="text-right">Depreciation</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {depreciationPreview.map(item => (
                      <TableRow key={item.assetId}>
                        <TableCell className="font-medium">{item.assetNumber} — {item.assetName}</TableCell>
                        <TableCell className="capitalize">{item.method.replace("_", " ")}</TableCell>
                        <TableCell className="text-right">{formatCurrency(item.bookValue)}</TableCell>
                        <TableCell className="text-right font-medium">{formatCurrency(item.monthlyDepreciation)}</TableCell>
                      </TableRow>
                    ))}
                    <TableRow>
                      <TableCell colSpan={3} className="font-bold text-right">Total</TableCell>
                      <TableCell className="text-right font-bold">
                        {formatCurrency(depreciationPreview.reduce((s, i) => s + i.monthlyDepreciation, 0))}
                      </TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              )}

              {depreciationPreview.length === 0 && !isPreviewing && (
                <p className="text-sm text-muted-foreground text-center py-4">
                  Click Preview to see depreciation amounts before posting.
                </p>
              )}

              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setShowDepreciationDialog(false)}>Cancel</Button>
                <Button onClick={handleRunDepreciation} disabled={isRunning || depreciationPreview.length === 0}>
                  {isRunning && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Post Depreciation
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>

        {/* Delete Confirmation Dialog */}
        <ConfirmDeleteDialog
          open={deleteConfirm.isOpen}
          onOpenChange={deleteConfirm.setIsOpen}
          title="Delete Asset"
          itemName={deleteConfirm.itemToDelete?.name}
          onConfirm={deleteConfirm.confirmDelete}
          isLoading={deleteConfirm.isDeleting}
        />
      </div>
    </>
  );
}
