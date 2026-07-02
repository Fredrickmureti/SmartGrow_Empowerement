import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";
import { useQuery } from "@tanstack/react-query";
import {
  FileText,
  ShoppingCart,
  Receipt,
  Package,
  ArrowLeftRight,
  ExternalLink,
} from "lucide-react";
import { useNavigate } from "react-router-dom";

interface SourceDocumentBadgeProps {
  referenceType: string | null;
  referenceId: string | null;
  onOpenDrawer?: (type: string, id: string) => void;
}

const REFERENCE_CONFIG: Record<string, { label: string; icon: React.ElementType; table: string; numberField: string; route?: string }> = {
  purchase_order: { label: "PO", icon: ShoppingCart, table: "purchase_orders", numberField: "order_number", route: "/purchases" },
  goods_receipt: { label: "GR", icon: Package, table: "goods_receipts", numberField: "receipt_number", route: "/purchases" },
  invoice: { label: "INV", icon: FileText, table: "invoices", numberField: "invoice_number", route: "/invoices" },
  bill: { label: "BILL", icon: Receipt, table: "bills", numberField: "bill_number", route: "/bills" },
  sales_order: { label: "SO", icon: ShoppingCart, table: "sales_orders", numberField: "order_number", route: "/sales" },
  pos_transaction: { label: "POS", icon: Receipt, table: "pos_transactions", numberField: "transaction_number", route: "/pos" },
  stock_adjustment: { label: "ADJ", icon: Package, table: "stock_adjustments", numberField: "adjustment_number" },
  stock_transfer: { label: "TRF", icon: ArrowLeftRight, table: "stock_transfers", numberField: "transfer_number" },
  delivery_note: { label: "DN", icon: Package, table: "delivery_notes", numberField: "delivery_number" },
  credit_note: { label: "CN", icon: FileText, table: "credit_notes", numberField: "credit_note_number" },
  migration: { label: "MIG", icon: Package, table: "", numberField: "" },
};

export function SourceDocumentBadge({ referenceType, referenceId, onOpenDrawer }: SourceDocumentBadgeProps) {
  const navigate = useNavigate();

  const config = referenceType ? REFERENCE_CONFIG[referenceType] : null;

  const { data: docNumber } = useQuery({
    queryKey: ["source-doc-number", referenceType, referenceId],
    queryFn: async () => {
      if (!config || !config.table || !referenceId) return null;
      const { data, error } = await supabase
        .from(config.table as any)
        .select(config.numberField)
        .eq("id", referenceId)
        .maybeSingle();
      if (error || !data) return null;
      return (data as any)[config.numberField] as string;
    },
    enabled: !!config?.table && !!referenceId,
    staleTime: 5 * 60 * 1000,
  });

  if (!referenceType || !referenceId) return <span className="text-muted-foreground">—</span>;

  if (!config) {
    return (
      <Badge variant="outline" className="text-xs">
        {referenceType}
      </Badge>
    );
  }

  const Icon = config.icon;
  const displayText = docNumber ? `${config.label}-${docNumber}` : config.label;

  const handleClick = () => {
    if (onOpenDrawer) {
      onOpenDrawer(referenceType, referenceId);
    } else if (config.route) {
      navigate(config.route);
    }
  };

  return (
    <Badge
      variant="outline"
      className="text-xs cursor-pointer hover:bg-accent transition-colors gap-1"
      onClick={handleClick}
    >
      <Icon className="h-3 w-3" />
      {displayText}
      <ExternalLink className="h-2.5 w-2.5 ml-0.5 opacity-50" />
    </Badge>
  );
}
