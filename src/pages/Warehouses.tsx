import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ConfirmDeleteDialog, useConfirmDelete } from "@/components/shared/ConfirmDeleteDialog";
import { useWarehouses, Warehouse, StockTransfer } from "@/hooks/useWarehouses";
import { useProducts } from "@/hooks/useProducts";
import { useCurrency } from "@/hooks/useCurrency";
import { useBranches } from "@/hooks/useBranches";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
// SCOPE-TRIGGER-EXEMPT: form selector for assigning a branch to a warehouse, not a scope switcher
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
  Warehouse as WarehouseIcon,
  ArrowRightLeft,
  MoreHorizontal,
  Pencil,
  Trash2,
  Package,
  MapPin,
  CheckCircle,
  XCircle,
} from "lucide-react";
import { RefreshButton } from "@/components/ui/RefreshButton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { format } from "date-fns";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useSubscriptionAccess } from "@/contexts/SubscriptionAccessContext";
import { PermissionGate } from "@/components/common/PermissionGate";
import { normalizeError } from "@/services/resilience";

export default function Warehouses() {
  const navigate = useNavigate();
  const {
    warehouses,
    transfers,
    isLoading,
    deleteWarehouse,
    createStockTransfer,
    approveTransfer,
    completeTransfer,
    cancelTransfer,
  } = useWarehouses();
  const { products } = useProducts();
  const { formatCurrency, isReady: currencyReady } = useCurrency();
  const { toast } = useToast();
  const { isReadOnly, openUpgradeModal } = useSubscriptionAccess();
  const { branches, currentBranch } = useBranches();
  const [activeTab, setActiveTab] = useState("warehouses");
  const [showTransferDialog, setShowTransferDialog] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [transferForm, setTransferForm] = useState({
    from_warehouse_id: "",
    to_warehouse_id: "",
    transfer_date: format(new Date(), "yyyy-MM-dd"),
    notes: "",
    items: [{ product_id: "", quantity: 1 }],
  });

  const resetTransferForm = () => {
    setTransferForm({
      from_warehouse_id: "",
      to_warehouse_id: "",
      transfer_date: format(new Date(), "yyyy-MM-dd"),
      notes: "",
      items: [{ product_id: "", quantity: 1 }],
    });
  };

  const handleOpenWarehouseCreate = () => {
    if (isReadOnly) {
      openUpgradeModal("warehouses");
      return;
    }
    navigate("/inventory-app/warehouses/new");
  };

  const handleOpenWarehouseEdit = (warehouse: Warehouse) => {
    if (isReadOnly) {
      openUpgradeModal("warehouses");
      return;
    }
    navigate(`/inventory-app/warehouses/${warehouse.id}/edit`);
  };

  const handleSubmitTransfer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (transferForm.from_warehouse_id === transferForm.to_warehouse_id) {
      toast({
        title: "Invalid transfer",
        description: "Source and destination warehouses must be different.",
        variant: "destructive",
      });
      return;
    }

    const validItems = transferForm.items.filter(
      (item) => item.product_id && item.quantity > 0
    ).map((item) => ({
      product_id: item.product_id,
      quantity_requested: item.quantity,
    }));
    if (validItems.length === 0) {
      toast({
        title: "No items",
        description: "Add at least one item to transfer.",
        variant: "destructive",
      });
      return;
    }

    setIsSubmitting(true);

    try {
      await createStockTransfer(
        transferForm.from_warehouse_id,
        transferForm.to_warehouse_id,
        validItems,
        transferForm.notes || undefined
      );
      toast({ title: "Stock transfer created successfully" });
      setShowTransferDialog(false);
      resetTransferForm();
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

  const executeDeleteWarehouse = async (warehouse: Warehouse) => {
    try {
      await deleteWarehouse(warehouse.id);
      toast({ title: "Warehouse deleted" });
    } catch (error: any) {
      toast({
        title: "Error",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    }
  };

  const deleteConfirm = useConfirmDelete<Warehouse>({ onConfirm: executeDeleteWarehouse });

  const handleDeleteWarehouse = (warehouse: Warehouse) => {
    if (isReadOnly) {
      openUpgradeModal("warehouses");
      return;
    }
    deleteConfirm.requestDelete(warehouse);
  };

  const handleApproveTransfer = async (transfer: StockTransfer) => {
    if (isReadOnly) {
      openUpgradeModal("warehouses");
      return;
    }
    try {
      await approveTransfer(transfer.id);
      toast({ title: "Transfer approved" });
    } catch (error: any) {
      toast({
        title: "Error",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    }
  };

  const handleCompleteTransfer = async (transfer: StockTransfer) => {
    if (isReadOnly) {
      openUpgradeModal("warehouses");
      return;
    }
    try {
      const itemsToReceive = (transfer.items || []).map((item) => ({
        id: item.id,
        quantity_received: item.quantity_sent || item.quantity_requested,
      }));
      await completeTransfer(transfer.id, itemsToReceive);
      toast({ title: "Transfer completed" });
    } catch (error: any) {
      toast({
        title: "Error",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    }
  };

  const handleCancelTransfer = async (transfer: StockTransfer) => {
    if (isReadOnly) {
      openUpgradeModal("warehouses");
      return;
    }
    try {
      await cancelTransfer(transfer.id);
      toast({ title: "Transfer cancelled successfully" });
    } catch (error: any) {
      toast({
        title: "Error",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    }
  };

  const addTransferItem = () => {
    setTransferForm({
      ...transferForm,
      items: [...transferForm.items, { product_id: "", quantity: 1 }],
    });
  };

  const removeTransferItem = (index: number) => {
    setTransferForm({
      ...transferForm,
      items: transferForm.items.filter((_, i) => i !== index),
    });
  };

  const updateTransferItem = (
    index: number,
    field: "product_id" | "quantity",
    value: string | number
  ) => {
    const newItems = [...transferForm.items];
    newItems[index] = { ...newItems[index], [field]: value };
    setTransferForm({ ...transferForm, items: newItems });
  };

  const filteredWarehouses = warehouses.filter((w) =>
    w.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    w.code?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const filteredTransfers = transfers.filter((t) =>
    t.transfer_number.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const getTransferStatusBadge = (status: StockTransfer["status"]) => {
    const styles: Record<string, string> = {
      draft: "bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-200",
      pending: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200",
      approved: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
      in_transit: "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200",
      completed: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
      cancelled: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
    };
    return <Badge className={styles[status]}>{status.replace("_", " ")}</Badge>;
  };

  return (
    <>
      <div className="space-y-4 sm:space-y-6">
        <div className="page-header">
          <div>
            <h1 className="page-title">Warehouses & Stock Transfers</h1>
            <p className="text-sm sm:text-base text-muted-foreground">
              Manage warehouse locations and stock movements
            </p>
          </div>
          <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto items-stretch sm:items-center">
            <RefreshButton
              queryKeyPrefixes={[
                ["warehouses"] as const,
                ["warehouse-stock-detail"] as const,
                ["stock-levels-paginated"] as const,
                ["warehouse-stock-totals"] as const,
              ]}
              tooltip="Refresh warehouses & stock"
            />
            <PermissionGate permission="manageProducts">
              <Button variant="outline" onClick={() => {
                if (isReadOnly) { openUpgradeModal("warehouses"); return; }
                setShowTransferDialog(true);
              }}>
                <ArrowRightLeft className="mr-2 h-4 w-4" />
                New Transfer
              </Button>
              <Button onClick={handleOpenWarehouseCreate} className="w-full sm:w-auto">
                <Plus className="mr-2 h-4 w-4" />
                Add Warehouse
              </Button>
            </PermissionGate>
          </div>
        </div>

        {/* Stats */}
        <div className="stats-grid grid-cols-1 sm:grid-cols-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Warehouses</CardTitle>
              <WarehouseIcon className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{warehouses.length}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Active Transfers</CardTitle>
              <ArrowRightLeft className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {transfers.filter((t) => !["completed", "cancelled"].includes(t.status)).length}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Completed Today</CardTitle>
              <CheckCircle className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {transfers.filter(
                  (t) =>
                    t.status === "completed" &&
                    t.completed_at &&
                    new Date(t.completed_at).toDateString() === new Date().toDateString()
                ).length}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Transfers</CardTitle>
              <Package className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{transfers.length}</div>
            </CardContent>
          </Card>
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList>
            <TabsTrigger value="warehouses">Warehouses</TabsTrigger>
            <TabsTrigger value="transfers">Stock Transfers</TabsTrigger>
          </TabsList>

          <TabsContent value="warehouses" className="space-y-4">
            {/* Search */}
            <div className="filter-bar">
              <div className="relative flex-1 min-w-0">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Search warehouses..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-10 w-full"
                />
              </div>
            </div>

            {/* Warehouses Table */}
            <Card>
              <CardContent className="p-0">
                {isLoading ? (
                  <div className="flex items-center justify-center py-12">
                    <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                  </div>
                ) : filteredWarehouses.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-12 text-center">
                    <WarehouseIcon className="h-12 w-12 text-muted-foreground mb-4" />
                    <h3 className="text-lg font-medium">No warehouses found</h3>
                    <p className="text-muted-foreground">
                      {warehouses.length === 0
                        ? "Create your first warehouse."
                        : "Try adjusting your search."}
                    </p>
                  </div>
                ) : (
                  <div className="table-container">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Name</TableHead>
                          <TableHead>Code</TableHead>
                          <TableHead>Location</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead className="w-12"></TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {filteredWarehouses.map((warehouse) => (
                          <TableRow key={warehouse.id}>
                            <TableCell>
                              <div className="flex items-center gap-2">
                                <span className="font-medium">{warehouse.name}</span>
                                {warehouse.is_default && (
                                  <Badge variant="secondary">Default</Badge>
                                )}
                              </div>
                            </TableCell>
                            <TableCell>{warehouse.code || "—"}</TableCell>
                            <TableCell>
                              <div className="flex items-center gap-1 text-muted-foreground">
                                <MapPin className="h-3 w-3" />
                                {[warehouse.city, warehouse.country]
                                  .filter(Boolean)
                                  .join(", ") || "—"}
                              </div>
                            </TableCell>
                            <TableCell>
                              <Badge
                                className={
                                  warehouse.is_active
                                    ? "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200"
                                    : "bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-200"
                                }
                              >
                                {warehouse.is_active ? "Active" : "Inactive"}
                              </Badge>
                            </TableCell>
                            <TableCell>
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button variant="ghost" size="icon">
                                    <MoreHorizontal className="h-4 w-4" />
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                  <DropdownMenuItem
                                    onClick={() => handleOpenWarehouseEdit(warehouse)}
                                  >
                                    <Pencil className="mr-2 h-4 w-4" />
                                    Edit
                                  </DropdownMenuItem>
                                  <DropdownMenuItem
                                    onClick={() => handleDeleteWarehouse(warehouse)}
                                    className="text-destructive"
                                  >
                                    <Trash2 className="mr-2 h-4 w-4" />
                                    Delete
                                  </DropdownMenuItem>
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
          </TabsContent>

          <TabsContent value="transfers" className="space-y-4">
            {/* Search */}
            <div className="filter-bar">
              <div className="relative flex-1 min-w-0">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Search transfers..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-10 w-full"
                />
              </div>
            </div>

            {/* Transfers Table */}
            <Card>
              <CardContent className="p-0">
                {isLoading ? (
                  <div className="flex items-center justify-center py-12">
                    <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                  </div>
                ) : filteredTransfers.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-12 text-center">
                    <ArrowRightLeft className="h-12 w-12 text-muted-foreground mb-4" />
                    <h3 className="text-lg font-medium">No transfers found</h3>
                    <p className="text-muted-foreground">
                      {transfers.length === 0
                        ? "Create your first stock transfer."
                        : "Try adjusting your search."}
                    </p>
                  </div>
                ) : (
                  <div className="table-container">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Transfer #</TableHead>
                          <TableHead>From</TableHead>
                          <TableHead>To</TableHead>
                          <TableHead>Date</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead>Actions</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {filteredTransfers.map((transfer) => (
                          <TableRow key={transfer.id}>
                            <TableCell className="font-medium">
                              {transfer.transfer_number}
                            </TableCell>
                            <TableCell>{transfer.from_warehouse?.name || "—"}</TableCell>
                            <TableCell>{transfer.to_warehouse?.name || "—"}</TableCell>
                            <TableCell>
                              {format(new Date(transfer.transfer_date), "MMM d, yyyy")}
                            </TableCell>
                            <TableCell>{getTransferStatusBadge(transfer.status)}</TableCell>
                            <TableCell>
                              <div className="flex gap-1">
                                {transfer.status === "pending" && (
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    onClick={() => handleApproveTransfer(transfer)}
                                    title="Approve"
                                  >
                                    <CheckCircle className="h-4 w-4" />
                                  </Button>
                                )}
                                {transfer.status === "approved" && (
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    onClick={() => handleCompleteTransfer(transfer)}
                                    title="Complete"
                                  >
                                    <CheckCircle className="h-4 w-4" />
                                  </Button>
                                )}
                                {["pending", "approved"].includes(transfer.status) && (
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    onClick={() => handleCancelTransfer(transfer)}
                                    title="Cancel"
                                  >
                                    <XCircle className="h-4 w-4" />
                                  </Button>
                                )}
                              </div>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

        {/* Transfer Dialog */}
        <Dialog open={showTransferDialog} onOpenChange={setShowTransferDialog}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Create Stock Transfer</DialogTitle>
              <DialogDescription>
                Transfer stock between warehouses.
              </DialogDescription>
            </DialogHeader>

            <ScrollArea className="max-h-[60vh]">
              <form onSubmit={handleSubmitTransfer} className="space-y-4 pr-4">
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label>From Warehouse *</Label>
                    <Select
                      value={transferForm.from_warehouse_id}
                      onValueChange={(value) =>
                        setTransferForm({ ...transferForm, from_warehouse_id: value })
                      }
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select source" />
                      </SelectTrigger>
                      <SelectContent>
                        {warehouses.map((wh) => (
                          <SelectItem key={wh.id} value={wh.id}>
                            {wh.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>To Warehouse *</Label>
                    <Select
                      value={transferForm.to_warehouse_id}
                      onValueChange={(value) =>
                        setTransferForm({ ...transferForm, to_warehouse_id: value })
                      }
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select destination" />
                      </SelectTrigger>
                      <SelectContent>
                        {warehouses.map((wh) => (
                          <SelectItem key={wh.id} value={wh.id}>
                            {wh.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2 md:col-span-2">
                    <Label>Transfer Date *</Label>
                    <Input
                      type="date"
                      value={transferForm.transfer_date}
                      onChange={(e) =>
                        setTransferForm({ ...transferForm, transfer_date: e.target.value })
                      }
                      required
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="flex justify-between items-center">
                    <Label>Items</Label>
                    <Button type="button" variant="ghost" size="sm" onClick={addTransferItem}>
                      <Plus className="h-4 w-4 mr-1" />
                      Add Item
                    </Button>
                  </div>
                  {transferForm.items.map((item, index) => (
                    <div key={index} className="flex gap-2 items-end">
                      <div className="flex-1">
                        <Select
                          value={item.product_id}
                          onValueChange={(value) =>
                            updateTransferItem(index, "product_id", value)
                          }
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Select product" />
                          </SelectTrigger>
                          <SelectContent>
                            {products.map((p) => (
                              <SelectItem key={p.id} value={p.id}>
                                {p.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="w-24">
                        <Input
                          type="number"
                          min="1"
                          value={item.quantity}
                          onChange={(e) =>
                            updateTransferItem(index, "quantity", parseInt(e.target.value) || 1)
                          }
                        />
                      </div>
                      {transferForm.items.length > 1 && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() => removeTransferItem(index)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  ))}
                </div>

                <div className="flex justify-end gap-2 pt-4">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setShowTransferDialog(false)}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" disabled={isSubmitting}>
                    {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Create Transfer
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
          title="Delete Warehouse"
          itemName={deleteConfirm.itemToDelete?.name}
          onConfirm={deleteConfirm.confirmDelete}
          isLoading={deleteConfirm.isDeleting}
        />
      </div>
    </>
  );
}
