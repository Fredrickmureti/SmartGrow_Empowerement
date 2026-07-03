import { DetailSheet } from "@/design-system/primitives/DetailSheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { ArrowLeftRight, ExternalLink, Loader2, Calendar, User } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { format } from "date-fns";

interface StockTransferPeekSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  transferId: string | null;
}

const STATUS_COLORS: Record<string, string> = {
  draft: "bg-gray-100 text-gray-800",
  pending: "bg-yellow-100 text-yellow-800",
  approved: "bg-blue-100 text-blue-800",
  in_transit: "bg-cyan-100 text-cyan-800",
  completed: "bg-green-100 text-green-800",
  cancelled: "bg-red-100 text-red-800",
};

export function StockTransferPeekSheet({ open, onOpenChange, transferId }: StockTransferPeekSheetProps) {
  const navigate = useNavigate();

  const { data: transfer, isLoading } = useQuery({
    queryKey: ["transfer-detail-drawer", transferId],
    queryFn: async () => {
      if (!transferId) return null;
      const { data, error } = await supabase
        .from("stock_transfers")
        .select(`
          *,
          from_warehouse:warehouses!stock_transfers_from_warehouse_id_fkey(id, name, code),
          to_warehouse:warehouses!stock_transfers_to_warehouse_id_fkey(id, name, code),
          stock_transfer_items(*, products(id, name, sku))
        `)
        .eq("id", transferId)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    enabled: !!transferId && open,
  });

  const createdBy = (transfer as any)?.created_by as string | undefined;
  const { data: creator } = useQuery({
    queryKey: ["profile", createdBy],
    queryFn: async () => {
      if (!createdBy) return null;
      const { data } = await supabase
        .from("profiles")
        .select("full_name, email")
        .eq("id", createdBy)
        .maybeSingle();
      return data;
    },
    enabled: !!createdBy && open,
  });

  const items = (transfer as any)?.stock_transfer_items || [];

  return (
    <DetailSheet
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title={
        <span className="flex items-center gap-2">
          <ArrowLeftRight className="h-5 w-5" />
          {transfer?.transfer_number || "Transfer Details"}
        </span>
      }
      description="Stock transfer information"
    >


        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : transfer ? (
          <div className="space-y-4 mt-6">
            {/* Status + Date */}
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-lg border p-3">
                <p className="text-xs text-muted-foreground">Status</p>
                <Badge className={`mt-1 capitalize ${STATUS_COLORS[transfer.status] || ""}`}>
                  {transfer.status?.replace("_", " ")}
                </Badge>
              </div>
              <div className="rounded-lg border p-3">
                <p className="text-xs text-muted-foreground flex items-center gap-1">
                  <Calendar className="h-3 w-3" /> Date
                </p>
                <p className="font-medium">
                  {transfer.transfer_date
                    ? format(new Date(transfer.transfer_date), "MMM d, yyyy")
                    : "—"}
                </p>
              </div>
            </div>

            {/* From / To */}
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-lg border p-3">
                <p className="text-xs text-muted-foreground">From Warehouse</p>
                <p className="font-semibold">{(transfer as any).from_warehouse?.name || "—"}</p>
              </div>
              <div className="rounded-lg border p-3">
                <p className="text-xs text-muted-foreground">To Warehouse</p>
                <p className="font-semibold">{(transfer as any).to_warehouse?.name || "—"}</p>
              </div>
            </div>

            {/* Creator */}
            {creator && (
              <div className="rounded-lg border p-3">
                <p className="text-xs text-muted-foreground flex items-center gap-1">
                  <User className="h-3 w-3" /> Created By
                </p>
                <p className="font-medium">{creator.full_name || creator.email || "Unknown"}</p>
              </div>
            )}

            {/* Notes */}
            {transfer.notes && (
              <>
                <Separator />
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Notes</p>
                  <p className="text-sm">{transfer.notes}</p>
                </div>
              </>
            )}

            {/* Items */}
            {items.length > 0 && (
              <>
                <Separator />
                <div>
                  <p className="text-sm font-semibold mb-2">Items ({items.length})</p>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="text-xs">Product</TableHead>
                        <TableHead className="text-xs text-right">Requested</TableHead>
                        <TableHead className="text-xs text-right">Sent</TableHead>
                        <TableHead className="text-xs text-right">Received</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {items.map((item: any) => (
                        <TableRow key={item.id}>
                          <TableCell className="text-sm">
                            <div>
                              <p className="font-medium">{item.products?.name || "—"}</p>
                              {item.products?.sku && (
                                <p className="text-xs text-muted-foreground">{item.products.sku}</p>
                              )}
                            </div>
                          </TableCell>
                          <TableCell className="text-right">{item.quantity_requested ?? item.quantity ?? 0}</TableCell>
                          <TableCell className="text-right">{item.quantity_sent ?? "—"}</TableCell>
                          <TableCell className="text-right">{item.quantity_received ?? "—"}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </>
            )}

            <Button
              variant="outline"
              className="w-full"
              onClick={() => {
                onOpenChange(false);
                navigate(`/inventory-app/warehouses?selected=${transferId}`);
              }}
            >
              <ExternalLink className="h-4 w-4 mr-2" />
              View Full Details
            </Button>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <ArrowLeftRight className="h-12 w-12 text-muted-foreground mb-4" />
            <p className="text-muted-foreground">Transfer not found</p>
          </div>
      )}
    </DetailSheet>

  );
}
