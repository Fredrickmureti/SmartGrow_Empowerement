import { DetailSheet } from "@/design-system/primitives/DetailSheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { ExternalLink, Loader2, Calendar, User, ClipboardList } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { format } from "date-fns";

interface AdjustmentPeekSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  adjustmentId: string | null;
}

const STATUS_COLORS: Record<string, string> = {
  draft: "bg-yellow-100 text-yellow-800",
  pending_approval: "bg-amber-100 text-amber-800",
  approved: "bg-green-100 text-green-800",
  cancelled: "bg-red-100 text-red-800",
};

/**
 * Peek sheet for a stock adjustment. Used behind `?peek=<id>` from the
 * Inventory adjustments list. Wraps `DetailSheet` (the primitive backing
 * `PeekScaffold` in the sales/purchases record system) so callers do not
 * need to know the underlying sheet primitive.
 */
export function AdjustmentPeekSheet({ open, onOpenChange, adjustmentId }: AdjustmentPeekSheetProps) {
  const navigate = useNavigate();

  const { data: adjustment, isLoading } = useQuery({
    queryKey: ["adjustment-detail-drawer", adjustmentId],
    queryFn: async () => {
      if (!adjustmentId) return null;
      const { data, error } = await supabase
        .from("stock_adjustments")
        .select(`
          *,
          stock_adjustment_items(*, products(id, name, sku))
        `)
        .eq("id", adjustmentId)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    enabled: !!adjustmentId && open,
  });

  const { data: creator } = useQuery({
    queryKey: ["profile", adjustment?.created_by],
    queryFn: async () => {
      if (!adjustment?.created_by) return null;
      const { data } = await supabase
        .from("profiles")
        .select("full_name, email")
        .eq("id", adjustment.created_by)
        .maybeSingle();
      return data;
    },
    enabled: !!adjustment?.created_by && open,
  });

  const { data: approver } = useQuery({
    queryKey: ["profile", adjustment?.approved_by],
    queryFn: async () => {
      if (!adjustment?.approved_by) return null;
      const { data } = await supabase
        .from("profiles")
        .select("full_name, email")
        .eq("id", adjustment.approved_by)
        .maybeSingle();
      return data;
    },
    enabled: !!adjustment?.approved_by && open,
  });

  const items = (adjustment as any)?.stock_adjustment_items || [];

  return (
    <DetailSheet
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title={
        <span className="flex items-center gap-2">
          <ClipboardList className="h-5 w-5" />
          {adjustment?.adjustment_number || "Adjustment Details"}
        </span>
      }
      description="Stock adjustment information"
    >


        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : adjustment ? (
          <div className="space-y-4 mt-6">
            {/* Status + Date + Reason */}
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-lg border p-3">
                <p className="text-xs text-muted-foreground">Status</p>
                <Badge className={`mt-1 capitalize ${STATUS_COLORS[adjustment.status] || ""}`}>
                  {adjustment.status}
                </Badge>
              </div>
              <div className="rounded-lg border p-3">
                <p className="text-xs text-muted-foreground flex items-center gap-1">
                  <Calendar className="h-3 w-3" /> Date
                </p>
                <p className="font-medium">
                  {format(new Date(adjustment.adjustment_date), "MMM d, yyyy")}
                </p>
              </div>
              <div className="rounded-lg border p-3 col-span-2">
                <p className="text-xs text-muted-foreground">Reason</p>
                <p className="font-medium capitalize">{adjustment.reason?.replace(/_/g, " ") || "—"}</p>
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

            {/* Approver */}
            {approver && adjustment.approved_at && (
              <div className="rounded-lg border p-3">
                <p className="text-xs text-muted-foreground flex items-center gap-1">
                  <User className="h-3 w-3" /> Approved By
                </p>
                <p className="font-medium">{approver.full_name || approver.email || "Unknown"}</p>
                <p className="text-xs text-muted-foreground">
                  {format(new Date(adjustment.approved_at), "MMM d, yyyy HH:mm")}
                </p>
              </div>
            )}

            {/* Notes */}
            {adjustment.notes && (
              <>
                <Separator />
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Notes</p>
                  <p className="text-sm">{adjustment.notes}</p>
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
                        <TableHead className="text-xs text-right">Before</TableHead>
                        <TableHead className="text-xs text-right">Change</TableHead>
                        <TableHead className="text-xs text-right">After</TableHead>
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
                          <TableCell className="text-right">{item.quantity_before}</TableCell>
                          <TableCell className="text-right">
                            <span className={item.quantity_adjustment >= 0 ? "text-green-600 font-medium" : "text-red-600 font-medium"}>
                              {item.quantity_adjustment >= 0 ? "+" : ""}{item.quantity_adjustment}
                            </span>
                          </TableCell>
                          <TableCell className="text-right font-semibold">{item.quantity_after}</TableCell>
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
                navigate(`/inventory-app/stock?tab=adjustments&selected=${adjustmentId}`);
              }}
            >
              <ExternalLink className="h-4 w-4 mr-2" />
              View Full Details
            </Button>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <ClipboardList className="h-12 w-12 text-muted-foreground mb-4" />
            <p className="text-muted-foreground">Adjustment not found</p>
          </div>
      )}
    </DetailSheet>

  );
}
