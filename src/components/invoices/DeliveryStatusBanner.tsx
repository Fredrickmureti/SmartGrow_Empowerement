import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Truck, CheckCircle2, AlertTriangle, ExternalLink } from "lucide-react";
import { useInvoiceDeliveryStatus } from "@/hooks/useInvoiceDeliveryStatus";
import { useCompleteDelivery } from "@/hooks/useDeliveryLifecycle";

interface Props {
  invoiceId: string;
  invoiceStatus: string;
  onClose?: () => void;
}

/**
 * Surfaces the Sales → Inventory link on a confirmed invoice.
 *
 * Architecture: invoices post Revenue/AR only. Stock + COGS are released
 * by `complete_delivery_atomic` when the linked Delivery Note is marked
 * Delivered. This banner makes that pending step impossible to miss and
 * provides one-click completion so users don't silently sell ghost stock.
 */
export function DeliveryStatusBanner({ invoiceId, invoiceStatus, onClose }: Props) {
  const { data, isLoading, refetch } = useInvoiceDeliveryStatus(invoiceId);
  const navigate = useNavigate();
  // Lifecycle transitions always go through the shared RPC wrapper so
  // toasts, cache invalidation and error handling stay identical everywhere.
  const complete = useCompleteDelivery(data?.delivery_note_id ?? null);
  const completing = complete.isPending;

  if (isLoading || !data?.found) return null;
  if (invoiceStatus === "draft" || invoiceStatus === "voided" || invoiceStatus === "cancelled") return null;
  if (!data.has_stockable_lines) return null;

  // No DN at all and no SO link → nothing to show (non-stockable invoice handled above)
  if (!data.delivery_note_id && !data.sales_order_id) return null;

  const completed = data.delivery_status === "delivered";

  const handleComplete = async () => {
    if (!data.delivery_note_id) return;
    await complete.mutateAsync({ id: data.delivery_note_id }).catch(() => undefined);
    await refetch();
  };

  if (completed) {
    return (
      <Alert className="border-emerald-200 bg-emerald-50 dark:bg-emerald-950/30 dark:border-emerald-900">
        <CheckCircle2 className="h-4 w-4 text-emerald-600" />
        <AlertTitle className="text-emerald-900 dark:text-emerald-200">Stock released</AlertTitle>
        <AlertDescription className="text-emerald-800 dark:text-emerald-300 flex items-center gap-2 flex-wrap">
          <span>Delivery {data.delivery_number} completed — inventory updated.</span>
          {data.delivery_note_id && (
            <Button
              size="sm"
              variant="link"
              className="h-auto p-0 text-emerald-900 dark:text-emerald-200"
              onClick={() => { onClose?.(); navigate(`/sales/delivery-notes?view=${data.delivery_note_id}`); }}
            >
              View delivery <ExternalLink className="h-3 w-3 ml-1" />
            </Button>
          )}
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <Alert className="border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-900">
      <AlertTriangle className="h-4 w-4 text-amber-600" />
      <AlertTitle className="text-amber-900 dark:text-amber-200 flex items-center gap-2">
        <Truck className="h-4 w-4" /> Delivery pending — stock not yet reduced
      </AlertTitle>
      <AlertDescription className="text-amber-800 dark:text-amber-300 space-y-2">
        <p>
          This invoice contains {data.stockable_line_count} stockable line
          {(data.stockable_line_count ?? 0) === 1 ? "" : "s"}. Inventory is
          released only when the linked delivery note is marked delivered.
        </p>
        <div className="flex gap-2 flex-wrap">
          {data.delivery_note_id && (
            <Button size="sm" onClick={handleComplete} disabled={completing}>
              <CheckCircle2 className="h-4 w-4 mr-1" />
              {completing ? "Releasing stock…" : "Complete delivery & release stock"}
            </Button>
          )}
          {data.delivery_note_id && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => { onClose?.(); navigate(`/sales/delivery-notes?view=${data.delivery_note_id}`); }}
            >
              Open {data.delivery_number}
            </Button>
          )}
        </div>
      </AlertDescription>
    </Alert>
  );
}