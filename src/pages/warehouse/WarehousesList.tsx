import { useState, type ComponentProps } from "react";
import {
  SummaryStatCard,
  SummaryStatGrid,
} from "@/components/common/SummaryStatCards";
import { useNavigate, useSearchParams } from "react-router-dom";
import { WarehousePeekSheet } from "@/components/warehouses/WarehousePeekSheet";
import { ConfirmDeleteDialog, useConfirmDelete } from "@/components/shared/ConfirmDeleteDialog";
import { useWarehouses, Warehouse, StockTransfer } from "@/hooks/useWarehouses";
import { useProducts } from "@/hooks/useProducts";
import { useCurrency } from "@/hooks/useCurrency";
import { useBranches } from "@/hooks/useBranches";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  PageHeader,
  PageBody,
  Section,
  FilterBar,
  EmptyState,
  LoadingState,
  StatusBadge,
} from "@/design-system";
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

/** Transfer lifecycle expressed in the ERP-wide tone vocabulary. */
const TRANSFER_TONE: Record<string, ComponentProps<typeof StatusBadge>["tone"]> = {
  draft: "neutral",
  pending: "warning",
  approved: "info",
  in_transit: "accent",
  completed: "success",
  cancelled: "danger",
};

export default function Warehouses() {
  const navigate = useNavigate();
  const {
    warehouses,
    transfers,
    isLoading,
    deleteWarehouse,
    approveTransfer,
    completeTransfer,
    cancelTransfer,
  } = useWarehouses();
  const { formatCurrency, isReady: currencyReady } = useCurrency();
  const { toast } = useToast();
  const { isReadOnly, openUpgradeModal } = useSubscriptionAccess();
  const [activeTab, setActiveTab] = useState("warehouses");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchParams, setSearchParams] = useSearchParams();
  const peekId = searchParams.get("peek");
  const setPeek = (id: string | null) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (id) next.set("peek", id);
      else next.delete("peek");
      return next;
    });
  };

  const handleOpenWarehouseCreate = () => {
    if (isReadOnly) {
      openUpgradeModal("warehouses");
      return;
    }
    navigate("/warehouse-app/warehouses/new");
  };

  const handleOpenWarehouseEdit = (warehouse: Warehouse) => {
    if (isReadOnly) {
      openUpgradeModal("warehouses");
      return;
    }
    navigate(`/warehouse-app/warehouses/${warehouse.id}/edit`);
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

  const filteredWarehouses = warehouses.filter((w) =>
    w.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    w.code?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const filteredTransfers = transfers.filter((t) =>
    t.transfer_number.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const getTransferStatusBadge = (status: StockTransfer["status"]) => (
    <StatusBadge tone={TRANSFER_TONE[status] ?? "neutral"}>
      {status.replace("_", " ")}
    </StatusBadge>
  );

  return (
    <>
      <PageHeader
        title="Warehouses & Stock Transfers"
        description="Every physical site you hold stock in, and the transfers moving inventory between them."
        actions={
          <>
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
                navigate("/inventory-app/transfers/new");
              }}>
                <ArrowRightLeft className="mr-2 h-4 w-4" />
                New Transfer
              </Button>
              <Button onClick={handleOpenWarehouseCreate}>
                <Plus className="mr-2 h-4 w-4" />
                Add Warehouse
              </Button>
            </PermissionGate>
          </>
        }
      />
      <PageBody>
        <SummaryStatGrid>
          <SummaryStatCard
            icon={<WarehouseIcon className="h-3.5 w-3.5" />}
            label="Warehouses"
            value={warehouses.length}
          />
          <SummaryStatCard
            icon={<ArrowRightLeft className="h-3.5 w-3.5" />}
            label="Active transfers"
            value={
              transfers.filter((t) => !["completed", "cancelled"].includes(t.status)).length
            }
          />
          <SummaryStatCard
            icon={<CheckCircle className="h-3.5 w-3.5" />}
            label="Completed today"
            value={
              transfers.filter(
                (t) =>
                  t.status === "completed" &&
                  t.completed_at &&
                  new Date(t.completed_at).toDateString() === new Date().toDateString(),
              ).length
            }
            tone="ok"
          />
          <SummaryStatCard
            icon={<Package className="h-3.5 w-3.5" />}
            label="Total transfers"
            value={transfers.length}
          />
        </SummaryStatGrid>

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList>
            <TabsTrigger value="warehouses">Warehouses</TabsTrigger>
            <TabsTrigger value="transfers">Stock Transfers</TabsTrigger>
          </TabsList>

          <TabsContent value="warehouses" className="space-y-4">
            <FilterBar
              search={searchQuery}
              onSearchChange={setSearchQuery}
              placeholder="Search warehouses…"
            />

            <Section contentClassName="p-0">
                {isLoading ? (
                  <LoadingState rows={5} />
                ) : filteredWarehouses.length === 0 ? (
                  <EmptyState
                    icon={WarehouseIcon}
                    title="No warehouses found"
                    description={
                      warehouses.length === 0
                        ? "Create your first warehouse to start holding stock."
                        : "No warehouse matches this search."
                    }
                  />
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
                          <TableRow
                            key={warehouse.id}
                            className="cursor-pointer hover:bg-muted/50"
                            onClick={() => setPeek(warehouse.id)}
                          >
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
                              <StatusBadge tone={warehouse.is_active ? "success" : "neutral"}>
                                {warehouse.is_active ? "Active" : "Inactive"}
                              </StatusBadge>
                            </TableCell>
                            <TableCell onClick={(e) => e.stopPropagation()}>
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
            </Section>
          </TabsContent>

          <TabsContent value="transfers" className="space-y-4">
            <FilterBar
              search={searchQuery}
              onSearchChange={setSearchQuery}
              placeholder="Search transfers…"
            />

            <Section contentClassName="p-0">
                {isLoading ? (
                  <LoadingState rows={5} />
                ) : filteredTransfers.length === 0 ? (
                  <EmptyState
                    icon={ArrowRightLeft}
                    title="No transfers found"
                    description={
                      transfers.length === 0
                        ? "Create your first stock transfer to move inventory between sites."
                        : "No transfer matches this search."
                    }
                  />
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
            </Section>
          </TabsContent>
        </Tabs>

        {/* Delete Confirmation Dialog */}
        <ConfirmDeleteDialog
          open={deleteConfirm.isOpen}
          onOpenChange={deleteConfirm.setIsOpen}
          title="Delete Warehouse"
          itemName={deleteConfirm.itemToDelete?.name}
          onConfirm={deleteConfirm.confirmDelete}
          isLoading={deleteConfirm.isDeleting}
        />

        <WarehousePeekSheet
          open={Boolean(peekId)}
          onOpenChange={(o) => (o ? undefined : setPeek(null))}
          warehouseId={peekId}
        />
      </PageBody>
    </>
  );
}
