/**
 * Stock Transfers — list + new-transfer dialog. Reuses the existing
 * `useWarehouses().createStockTransfer` mutation and `TransferDetailDrawer`.
 * Honors `?action=new&product=<id>` for deep-link prefill from the product
 * form's "Transfer" CTA.
 */
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useWarehouses } from "@/hooks/useWarehouses";
import { useProducts } from "@/hooks/useProducts";
import { useBranches } from "@/hooks/useBranches";
import { useBusinesses } from "@/hooks/useBusinesses";
import { TransferDetailDrawer } from "@/components/inventory/TransferDetailDrawer";
import { BarcodeInputField } from "@/components/scanner/BarcodeInputField";
import { ScannerPairingButton } from "@/components/scanner/ScannerPairingButton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  ArrowLeftRight, Plus, Loader2, CheckCircle, XCircle, Clock, Truck, Trash2,
} from "lucide-react";
import { format } from "date-fns";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { toast } from "sonner";

type Item = { product_id: string; quantity_requested: number };

export default function Transfers() {
  const { warehouses, transfers, isLoading, createStockTransfer, approveTransfer, completeTransfer, cancelTransfer } = useWarehouses();
  const { products } = useProducts();
  const { currentBranch } = useBranches();
  const [searchParams, setSearchParams] = useSearchParams();

  const { currentBusiness } = useBusinesses();
  const [showDialog, setShowDialog] = useState(false);
  const [fromWarehouseId, setFromWarehouseId] = useState("");
  const [toWarehouseId, setToWarehouseId] = useState("");
  const [notes, setNotes] = useState("");
  const [items, setItems] = useState<Item[]>([{ product_id: "", quantity_requested: 1 }]);
  const [submitting, setSubmitting] = useState(false);
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [scanCode, setScanCode] = useState("");
  const [scanFlash, setScanFlash] = useState<string | null>(null);

  const handleScanLine = (code: string) => {
    const norm = code.trim();
    if (!norm) return;
    setScanCode("");
    const match = inventoryProducts.find(
      (p: any) => p.sku && p.sku.toLowerCase() === norm.toLowerCase(),
    );
    if (!match) {
      setScanFlash(`No product matches "${norm}"`);
      window.setTimeout(() => setScanFlash(null), 2500);
      return;
    }
    setItems((prev) => {
      const idx = prev.findIndex((i) => i.product_id === match.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = { ...next[idx], quantity_requested: (next[idx].quantity_requested || 0) + 1 };
        return next;
      }
      // Replace the trailing empty placeholder row, if any.
      const trailingEmpty = prev.length > 0 && !prev[prev.length - 1].product_id;
      const base = trailingEmpty ? prev.slice(0, -1) : prev;
      return [...base, { product_id: match.id, quantity_requested: 1 }];
    });
    setScanFlash(`+1 ${match.name}`);
    window.setTimeout(() => setScanFlash(null), 1500);
  };

  const inventoryProducts = useMemo(
    () => products.filter((p: any) => p.type === "product" && p.is_active),
    [products]
  );

  // Deep-link prefill from product form
  useEffect(() => {
    if (searchParams.get("action") !== "new") return;
    const productId = searchParams.get("product");
    if (showDialog) return;
    if (productId) {
      setItems([{ product_id: productId, quantity_requested: 1 }]);
    }
    setShowDialog(true);
    const next = new URLSearchParams(searchParams);
    next.delete("action");
    next.delete("product");
    setSearchParams(next, { replace: true });
  }, [searchParams, showDialog, setSearchParams]);

  const resetForm = () => {
    setFromWarehouseId(""); setToWarehouseId(""); setNotes("");
    setItems([{ product_id: "", quantity_requested: 1 }]);
  };

  const submit = async () => {
    if (!fromWarehouseId || !toWarehouseId) {
      toast.error("Pick source and destination warehouses");
      return;
    }
    if (fromWarehouseId === toWarehouseId) {
      toast.error("Source and destination must differ");
      return;
    }
    const filtered = items.filter(i => i.product_id && i.quantity_requested > 0);
    if (filtered.length === 0) {
      toast.error("Add at least one product to transfer");
      return;
    }
    setSubmitting(true);
    try {
      await createStockTransfer(fromWarehouseId, toWarehouseId, filtered, notes || undefined);
      setShowDialog(false);
      resetForm();
    } catch (e: any) {
      // toast already raised in hook
    } finally {
      setSubmitting(false);
    }
  };

  const statusBadge = (s: string) => {
    switch (s) {
      case "draft": return <Badge variant="outline"><Clock className="h-3 w-3 mr-1" />Draft</Badge>;
      case "approved":
      case "in_transit": return <Badge className="bg-blue-100 text-blue-800"><Truck className="h-3 w-3 mr-1" />In transit</Badge>;
      case "completed": return <Badge className="bg-green-100 text-green-800"><CheckCircle className="h-3 w-3 mr-1" />Completed</Badge>;
      case "cancelled": return <Badge variant="destructive"><XCircle className="h-3 w-3 mr-1" />Cancelled</Badge>;
      default: return <Badge variant="outline">{s}</Badge>;
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div>
          <h1 className="page-title flex items-center gap-2">
            <ArrowLeftRight className="h-5 w-5" /> Stock Transfers
          </h1>
          <p className="text-sm text-muted-foreground">
            Move stock between warehouses. Dispatch parks goods in the in-transit
            location until the destination confirms receipt — valuation stays
            truthful while goods are in motion.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <RefreshButton
            queryKeyPrefixes={[
              ["stock-transfers"] as const,
              ["warehouses"] as const,
              ["warehouse-stock-detail"] as const,
              ["stock-levels-paginated"] as const,
            ]}
            tooltip="Refresh transfers"
          />
          <Button onClick={() => setShowDialog(true)}>
            <Plus className="h-4 w-4 mr-1" /> New Transfer
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">All transfers</CardTitle>
          <CardDescription>
            {currentBranch ? `Touching branch: ${currentBranch.name}` : "All branches"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : transfers.length === 0 ? (
            <div className="text-center py-12 text-sm text-muted-foreground">
              No transfers yet. Click <strong>New Transfer</strong> to move stock
              between warehouses.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Number</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>From</TableHead>
                  <TableHead>To</TableHead>
                  <TableHead>Items</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {transfers.map((t: any) => (
                  <TableRow
                    key={t.id}
                    className="cursor-pointer"
                    onClick={() => setDrawerId(t.id)}
                  >
                    <TableCell className="font-mono text-xs">{t.transfer_number}</TableCell>
                    <TableCell className="text-xs">
                      {t.transfer_date ? format(new Date(t.transfer_date), "MMM d, yyyy") : "—"}
                    </TableCell>
                    <TableCell className="text-xs">
                      {t.from_warehouse?.name || "—"}
                    </TableCell>
                    <TableCell className="text-xs">
                      {t.to_warehouse?.name || "—"}
                    </TableCell>
                    <TableCell className="text-xs">{t.items?.length ?? 0}</TableCell>
                    <TableCell>{statusBadge(t.status)}</TableCell>
                    <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                      <div className="inline-flex gap-1">
                        {t.status === "draft" && (
                          <Button size="sm" variant="outline" onClick={() => approveTransfer(t.id)}>
                            Dispatch
                          </Button>
                        )}
                        {(t.status === "approved" || t.status === "in_transit") && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              completeTransfer(
                                t.id,
                                (t.items || []).map((it: any) => ({
                                  id: it.id,
                                  quantity_received: Number(it.quantity_sent ?? it.quantity_requested) || 0,
                                }))
                              )
                            }
                          >
                            Receive
                          </Button>
                        )}
                        {(t.status === "draft" || t.status === "approved") && (
                          <Button size="sm" variant="ghost" onClick={() => cancelTransfer(t.id)}>
                            <XCircle className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* New Transfer dialog */}
      <Dialog open={showDialog} onOpenChange={(o) => { setShowDialog(o); if (!o) resetForm(); }}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>New Stock Transfer</DialogTitle>
            <DialogDescription>
              Stock leaves the source warehouse on dispatch and enters the
              destination on receive. Quantities are validated against on-hand
              when you dispatch.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>From warehouse</Label>
                <Select value={fromWarehouseId} onValueChange={setFromWarehouseId}>
                  <SelectTrigger><SelectValue placeholder="Source" /></SelectTrigger>
                  <SelectContent>
                    {warehouses.map((w) => (
                      <SelectItem key={w.id} value={w.id}>{w.name} ({w.code})</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>To warehouse</Label>
                <Select value={toWarehouseId} onValueChange={setToWarehouseId}>
                  <SelectTrigger><SelectValue placeholder="Destination" /></SelectTrigger>
                  <SelectContent>
                    {warehouses.filter(w => w.id !== fromWarehouseId).map((w) => (
                      <SelectItem key={w.id} value={w.id}>{w.name} ({w.code})</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <Label>Items</Label>
                <div className="flex items-center gap-2">
                  <ScannerPairingButton
                    businessId={currentBusiness?.id}
                    branchId={currentBranch?.id ?? null}
                    label="Stock transfer"
                  />
                  <Button size="sm" variant="outline"
                    onClick={() => setItems([...items, { product_id: "", quantity_requested: 1 }])}
                  >
                    <Plus className="h-3 w-3 mr-1" /> Add line
                  </Button>
                </div>
              </div>
              <div className="mb-2">
                <BarcodeInputField
                  value={scanCode}
                  onChange={setScanCode}
                  onScan={handleScanLine}
                  businessId={currentBusiness?.id}
                  branchId={currentBranch?.id ?? null}
                  allowRepeats
                  workflow="quantity"
                  fieldLabel="Transfer line"
                  placeholder="Scan a barcode to add or increment a line"
                />
                {scanFlash && (
                  <p className="text-xs text-muted-foreground mt-1">{scanFlash}</p>
                )}
              </div>

              <div className="space-y-2">
                {items.map((it, idx) => (
                  <div key={idx} className="grid grid-cols-[1fr_120px_40px] gap-2 items-center">
                    <Select
                      value={it.product_id}
                      onValueChange={(v) => {
                        const next = [...items]; next[idx] = { ...next[idx], product_id: v };
                        setItems(next);
                      }}
                    >
                      <SelectTrigger><SelectValue placeholder="Product" /></SelectTrigger>
                      <SelectContent>
                        {inventoryProducts.map((p: any) => (
                          <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Input
                      type="number" min="0" step="any"
                      value={it.quantity_requested}
                      onChange={(e) => {
                        const next = [...items];
                        next[idx] = { ...next[idx], quantity_requested: Number(e.target.value) || 0 };
                        setItems(next);
                      }}
                    />
                    <Button size="icon" variant="ghost"
                      onClick={() => setItems(items.filter((_, i) => i !== idx))}
                      disabled={items.length === 1}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
            </div>

            <div className="space-y-1">
              <Label>Notes (optional)</Label>
              <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Reason / reference" />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDialog(false)}>Cancel</Button>
            <Button onClick={submit} disabled={submitting}>
              {submitting && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
              Create transfer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <TransferDetailDrawer
        open={!!drawerId}
        onOpenChange={(o) => { if (!o) setDrawerId(null); }}
        transferId={drawerId}
      />
    </div>
  );
}
