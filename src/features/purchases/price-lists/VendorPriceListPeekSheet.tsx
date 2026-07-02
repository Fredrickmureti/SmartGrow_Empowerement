import { useState } from "react";
import { format } from "date-fns";
import { DetailSheet } from "@/design-system/primitives/DetailSheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Building2,
  Package,
  Hash,
  Coins,
  Calendar,
  Clock,
  Truck,
  Star,
  FileText,
  Edit,
  Trash2,
  ShoppingCart,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  RefreshCw,
} from "lucide-react";
import { useCurrency } from "@/hooks/useCurrency";
import { DocumentHistoryTab } from "@/components/common/DocumentHistoryTab";
import { ClickableEntity } from "@/components/common/ClickableEntity";
import { ContactPreviewDrawer } from "@/components/contacts/ContactPreviewDrawer";

interface VendorPriceListEntry {
  id: string;
  vendor_id: string;
  product_id: string;
  unit_price: number;
  currency: string | null;
  min_order_qty: number;
  lead_time_days: number;
  is_preferred: boolean;
  is_active: boolean;
  valid_from: string | null;
  valid_until: string | null;
  notes: string | null;
  created_at?: string;
  vendor?: { name: string } | null;
  product?: { name: string; sku: string | null } | null;
}

interface VendorPriceListPeekSheetProps {
  entry: VendorPriceListEntry | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onEdit: (entry: VendorPriceListEntry) => void;
  onDelete: (id: string) => void;
  onSetPreferred: (id: string) => void;
  onCreatePO?: (entry: VendorPriceListEntry) => void;
  onRenew?: (entry: VendorPriceListEntry) => void;
}

function DetailRow({ icon: Icon, label, value }: { icon: React.ElementType; label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-1.5">
      <Icon className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
      <div className="grid grid-cols-[120px_1fr] gap-2 flex-1 min-w-0">
        <span className="text-sm text-muted-foreground">{label}</span>
        <span className="text-sm font-medium break-words">{value || "—"}</span>
      </div>
    </div>
  );
}

function getStatusInfo(entry: VendorPriceListEntry) {
  const today = new Date().toISOString().split("T")[0];
  const soon = new Date();
  soon.setDate(soon.getDate() + 30);
  const soonStr = soon.toISOString().split("T")[0];

  if (!entry.is_active) return { label: "Inactive", variant: "secondary" as const, icon: XCircle };
  if (entry.valid_until && entry.valid_until < today) return { label: "Expired", variant: "destructive" as const, icon: XCircle };
  if (entry.valid_until && entry.valid_until >= today && entry.valid_until <= soonStr) return { label: "Expiring Soon", variant: "outline" as const, icon: AlertTriangle };
  return { label: "Active", variant: "default" as const, icon: CheckCircle2 };
}

export function VendorPriceListPeekSheet({
  entry,
  open,
  onOpenChange,
  onEdit,
  onDelete,
  onSetPreferred,
  onCreatePO,
  onRenew,
}: VendorPriceListPeekSheetProps) {
  const { formatCurrency, baseCurrency } = useCurrency();
  const [contactDrawerOpen, setContactDrawerOpen] = useState(false);

  if (!entry) return null;

  const status = getStatusInfo(entry);
  const isExpired = status.label === "Expired";
  const isActive = entry.is_active && !isExpired;

  return (
    <>
    <DetailSheet
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={<span className="truncate">{entry.product?.name || "Unknown Product"}</span>}
      description={
        <>
          {entry.vendor?.name || "Unknown Vendor"}
          {entry.product?.sku && <span className="ml-2">• SKU: {entry.product.sku}</span>}
        </>
      }
      headerActions={
        <div className="flex flex-col items-end gap-1">
          <span className="text-lg font-bold">
            {formatCurrency(entry.unit_price, entry.currency || baseCurrency)}
          </span>
          <div className="flex items-center gap-1.5">
            <Badge variant={status.variant}>{status.label}</Badge>
            {entry.is_preferred && (
              <Badge className="bg-amber-500 text-white">
                <Star className="h-3 w-3 mr-0.5" /> Preferred
              </Badge>
            )}
          </div>
        </div>
      }
    >
        <ScrollArea className="max-h-[60vh]">
          <div className="space-y-1">

            {/* Context-Aware Actions */}
            <div className="flex flex-wrap gap-2 pb-3">
              {isActive && (
                <Button size="sm" variant="outline" onClick={() => { onOpenChange(false); onEdit(entry); }}>
                  <Edit className="mr-1.5 h-3.5 w-3.5" /> Edit Entry
                </Button>
              )}
              {isActive && !entry.is_preferred && (
                <Button size="sm" variant="outline" onClick={() => { onSetPreferred(entry.id); onOpenChange(false); }}>
                  <Star className="mr-1.5 h-3.5 w-3.5" /> Set Preferred
                </Button>
              )}
              {isActive && onCreatePO && (
                <Button size="sm" onClick={() => { onOpenChange(false); onCreatePO(entry); }}>
                  <ShoppingCart className="mr-1.5 h-3.5 w-3.5" /> Create Purchase Order
                </Button>
              )}
              {isExpired && onRenew && (
                <Button size="sm" variant="outline" onClick={() => { onOpenChange(false); onRenew(entry); }}>
                  <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Renew Entry
                </Button>
              )}
              {isExpired && (
                <Button size="sm" variant="outline" onClick={() => { onOpenChange(false); onEdit(entry); }}>
                  <Edit className="mr-1.5 h-3.5 w-3.5" /> Edit & Reactivate
                </Button>
              )}
              <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => { onDelete(entry.id); onOpenChange(false); }}>
                <Trash2 className="mr-1.5 h-3.5 w-3.5" /> Remove
              </Button>
            </div>

            <Separator />

            {/* Vendor & Product Details */}
            <div className="pt-3 pb-1">
              <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Vendor & Product</h4>
              <div className="flex items-start gap-3 py-1.5">
                <Building2 className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
                <div className="grid grid-cols-[120px_1fr] gap-2 flex-1 min-w-0">
                  <span className="text-sm text-muted-foreground">Vendor</span>
                  {entry.vendor_id ? (
                    <ClickableEntity onClick={() => setContactDrawerOpen(true)}>
                      {entry.vendor?.name || "—"}
                    </ClickableEntity>
                  ) : (
                    <span className="text-sm font-medium">—</span>
                  )}
                </div>
              </div>
              <DetailRow icon={Package} label="Product" value={entry.product?.name} />
              <DetailRow icon={Hash} label="SKU" value={entry.product?.sku} />
            </div>

            <Separator />

            {/* Pricing & Terms */}
            <div className="pt-3 pb-1">
              <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Pricing & Terms</h4>
              <DetailRow icon={Coins} label="Unit Price" value={formatCurrency(entry.unit_price, entry.currency || baseCurrency)} />
              <DetailRow icon={ShoppingCart} label="Min Order Qty" value={entry.min_order_qty.toString()} />
              <DetailRow icon={Truck} label="Lead Time" value={entry.lead_time_days > 0 ? `${entry.lead_time_days} days` : "Not specified"} />
              <DetailRow
                icon={Star}
                label="Preferred"
                value={
                  entry.is_preferred ? (
                    <Badge className="bg-amber-500 text-white text-xs"><Star className="h-3 w-3 mr-0.5" /> Yes</Badge>
                  ) : "No"
                }
              />
            </div>

            <Separator />

            {/* Validity Period */}
            <div className="pt-3 pb-1">
              <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Validity</h4>
              <DetailRow
                icon={Calendar}
                label="Valid From"
                value={entry.valid_from ? format(new Date(entry.valid_from), "MMM d, yyyy") : "No start date"}
              />
              <DetailRow
                icon={Calendar}
                label="Valid Until"
                value={entry.valid_until ? format(new Date(entry.valid_until), "MMM d, yyyy") : "No expiry"}
              />
              <DetailRow
                icon={Clock}
                label="Created"
                value={entry.created_at ? format(new Date(entry.created_at), "MMM d, yyyy 'at' h:mm a") : "—"}
              />
            </div>

            {/* Notes */}
            {entry.notes && (
              <>
                <Separator />
                <div className="pt-3 pb-1">
                  <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Notes</h4>
                  <DetailRow icon={FileText} label="Notes" value={entry.notes} />
                </div>
              </>
            )}

            {/* Activity History */}
            <Separator />
            <div className="pt-3">
              <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Activity</h4>
              <DocumentHistoryTab entityType="vendor_price_list" entityId={entry.id} />
            </div>
          </div>
        </ScrollArea>
    </DetailSheet>


    <ContactPreviewDrawer
      open={contactDrawerOpen}
      onOpenChange={setContactDrawerOpen}
      contactId={entry?.vendor_id || null}
    />
    </>
  );
}
