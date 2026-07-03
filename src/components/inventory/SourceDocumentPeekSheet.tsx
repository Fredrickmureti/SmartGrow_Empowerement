import { DetailSheet } from "@/design-system/primitives/DetailSheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ExternalLink, Loader2, FileText } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useCurrency } from "@/hooks/useCurrency";
import { format } from "date-fns";

interface SourceDocumentPeekSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  referenceType: string | null;
  referenceId: string | null;
}

const DOC_CONFIG: Record<string, {
  table: string;
  select: string;
  titleField: string;
  dateField: string;
  statusField?: string;
  totalField?: string;
  contactField?: string;
  route: string;
}> = {
  purchase_order: {
    table: "purchase_orders",
    select: "*, contacts(company_name, name)",
    titleField: "order_number",
    dateField: "order_date",
    statusField: "status",
    totalField: "total",
    contactField: "contacts",
    route: "/purchases",
  },
  invoice: {
    table: "invoices",
    select: "*, contacts(company_name, name)",
    titleField: "invoice_number",
    dateField: "invoice_date",
    statusField: "status",
    totalField: "total",
    contactField: "contacts",
    route: "/invoices",
  },
  bill: {
    table: "bills",
    select: "*, vendor:contacts!bills_vendor_id_fkey(company_name, name)",
    titleField: "bill_number",
    dateField: "bill_date",
    statusField: "status",
    totalField: "total",
    contactField: "vendor",
    route: "/bills",
  },
  sales_order: {
    table: "sales_orders",
    select: "*, contacts(company_name, name)",
    titleField: "order_number",
    dateField: "order_date",
    statusField: "status",
    totalField: "total",
    contactField: "contacts",
    route: "/sales",
  },
  pos_transaction: {
    table: "pos_transactions",
    select: "*",
    titleField: "transaction_number",
    dateField: "created_at",
    statusField: "status",
    totalField: "total",
    route: "/pos",
  },
  stock_adjustment: {
    table: "stock_adjustments",
    select: "*",
    titleField: "adjustment_number",
    dateField: "adjustment_date",
    statusField: "status",
    route: "/inventory-app/stock",
  },
  stock_transfer: {
    table: "stock_transfers",
    select: "*, from_warehouse:warehouses!stock_transfers_from_warehouse_id_fkey(name), to_warehouse:warehouses!stock_transfers_to_warehouse_id_fkey(name)",
    titleField: "transfer_number",
    dateField: "transfer_date",
    statusField: "status",
    route: "/inventory-app/warehouses",
  },
};

export function SourceDocumentPeekSheet({
  open,
  onOpenChange,
  referenceType,
  referenceId,
}: SourceDocumentPeekSheetProps) {
  const navigate = useNavigate();
  const { formatCurrency } = useCurrency();

  const config = referenceType ? DOC_CONFIG[referenceType] : null;

  const { data: document, isLoading } = useQuery({
    queryKey: ["source-doc-drawer", referenceType, referenceId],
    queryFn: async () => {
      if (!config || !referenceId) return null;
      const { data, error } = await supabase
        .from(config.table as any)
        .select(config.select)
        .eq("id", referenceId)
        .maybeSingle();
      if (error) throw error;
      return data as any;
    },
    enabled: !!config && !!referenceId && open,
  });

  const docTitle = document?.[config?.titleField || ""] || referenceType || "Document";
  const docDate = document?.[config?.dateField || ""];
  const docStatus = config?.statusField ? document?.[config.statusField] : null;
  const docTotal = config?.totalField ? document?.[config.totalField] : null;
  const contact = config?.contactField ? document?.[config.contactField] : null;
  const contactName = contact?.company_name || contact?.name || null;

  return (
    <DetailSheet
      open={open}
      onOpenChange={onOpenChange}
      size="sm"
      title={
        <span className="flex items-center gap-2">
          <FileText className="h-5 w-5" />
          {docTitle}
        </span>
      }
      description={`${referenceType?.replace("_", " ").replace(/\b\w/g, l => l.toUpperCase())} details`}
    >


        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : document ? (
          <div className="space-y-4 mt-6">
            <div className="grid grid-cols-2 gap-3">
              {docDate && (
                <div className="rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground">Date</p>
                  <p className="font-medium">{format(new Date(docDate), "MMM d, yyyy")}</p>
                </div>
              )}
              {docStatus && (
                <div className="rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground">Status</p>
                  <Badge variant="outline" className="capitalize mt-1">{docStatus}</Badge>
                </div>
              )}
              {docTotal != null && (
                <div className="rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground">Total</p>
                  <p className="font-semibold">{formatCurrency(docTotal)}</p>
                </div>
              )}
              {contactName && (
                <div className="rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground">Contact</p>
                  <p className="font-medium truncate">{contactName}</p>
                </div>
              )}
            </div>

            {/* Transfer-specific info */}
            {referenceType === "stock_transfer" && document.from_warehouse && (
              <>
                <Separator />
                <div className="space-y-2">
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">From</span>
                    <span className="font-medium">{document.from_warehouse.name}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">To</span>
                    <span className="font-medium">{document.to_warehouse.name}</span>
                  </div>
                </div>
              </>
            )}

            {/* POS-specific info */}
            {referenceType === "pos_transaction" && (
              <>
                <Separator />
                <div className="space-y-2">
                  {document.customer_name && (
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">Customer</span>
                      <span className="font-medium">{document.customer_name}</span>
                    </div>
                  )}
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Type</span>
                    <Badge variant="outline" className="capitalize">{document.transaction_type}</Badge>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Payment</span>
                    <Badge variant="outline" className="capitalize">{document.payment_status}</Badge>
                  </div>
                </div>
              </>
            )}

            {document.notes && (
              <>
                <Separator />
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Notes</p>
                  <p className="text-sm">{document.notes}</p>
                </div>
              </>
            )}

            {config?.route && referenceId && (
              <Button
                variant="outline"
                className="w-full"
                onClick={() => {
                  onOpenChange(false);
                  navigate(`${config.route}?selected=${referenceId}`);
                }}
              >
                <ExternalLink className="h-4 w-4 mr-2" />
                View Full Details
              </Button>
            )}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <FileText className="h-12 w-12 text-muted-foreground mb-4" />
            <p className="text-muted-foreground">Document not found</p>
          </div>
      )}
    </DetailSheet>

  );
}
