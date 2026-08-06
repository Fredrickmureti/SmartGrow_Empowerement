/**
 * DocumentLifecycleStrip — traversal across the document lifecycle.
 *
 * Enterprise operators do not think in tables, they think in chains: a
 * quotation became an order, the order shipped on a delivery note, the note
 * was invoiced, the invoice was paid, the payment posted a journal entry.
 * This strip renders that chain for whichever document you are standing on,
 * with the current step marked and every other step navigable.
 *
 * Backed by the `get_document_lineage` RPC. Steps the RPC does not return
 * render as unrealised (dimmed, not clickable) so the operator can see what
 * has *not* happened yet — the absence is information.
 */
import { Fragment } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  ChevronRight,
  ClipboardList,
  CreditCard,
  FileText,
  Receipt,
  RotateCcw,
  ScrollText,
  Truck,
  Undo2,
} from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { documentStatusLabel, type DocumentKind } from "./documentStatus";

export type LifecycleDocType =
  | "estimate"
  | "proforma_invoice"
  | "sales_order"
  | "delivery_note"
  | "invoice"
  | "payment"
  | "credit_note"
  | "sales_return";

interface LineageNode {
  id: string;
  number: string | null;
  status: string | null;
  date: string | null;
}

type LineageResponse = Partial<Record<LifecycleDocType, LineageNode | null>> & {
  error?: string;
};

interface Step {
  key: LifecycleDocType;
  label: string;
  icon: typeof FileText;
  kind: DocumentKind;
  path: (id: string) => string;
}

/**
 * The order-to-cash chain, in business order. Downstream settlement steps
 * (payment, credit note, return) were previously unreachable from any
 * document surface even though the data existed.
 */
const STEPS: Step[] = [
  { key: "estimate", label: "Quotation", icon: ClipboardList, kind: "estimate", path: (id) => `/sales/estimates/${id}` },
  { key: "proforma_invoice", label: "Proforma", icon: ScrollText, kind: "proforma", path: (id) => `/sales/proforma/${id}` },
  { key: "sales_order", label: "Sales Order", icon: FileText, kind: "sales_order", path: (id) => `/sales/orders/${id}` },
  { key: "delivery_note", label: "Delivery", icon: Truck, kind: "delivery_note", path: (id) => `/sales/delivery-notes/${id}` },
  { key: "invoice", label: "Invoice", icon: Receipt, kind: "invoice", path: (id) => `/sales/invoices/${id}` },
  { key: "payment", label: "Payment", icon: CreditCard, kind: "customer_payment", path: (id) => `/sales/payments/${id}` },
  { key: "credit_note", label: "Credit Note", icon: Undo2, kind: "credit_note", path: (id) => `/sales/credit-notes/${id}` },
  { key: "sales_return", label: "Return", icon: RotateCcw, kind: "sales_return", path: (id) => `/sales/returns/${id}` },
];

interface Props {
  docType: LifecycleDocType;
  docId: string;
  className?: string;
  /** Compact rendering for the peek drawer. */
  dense?: boolean;
}

export function DocumentLifecycleStrip({ docType, docId, className, dense }: Props) {
  const { data, isLoading } = useQuery({
    queryKey: ["document-lineage", docType, docId],
    queryFn: async (): Promise<LineageResponse> => {
      const { data, error } = await supabase.rpc("get_document_lineage", {
        p_doc_type: docType,
        p_doc_id: docId,
      });
      if (error) throw error;
      return (data ?? {}) as LineageResponse;
    },
    enabled: !!docId,
    staleTime: 60_000,
  });

  if (isLoading) {
    return <Skeleton className={cn("h-12 w-full", className)} />;
  }
  if (!data || data.error) return null;

  const realised = STEPS.filter((s) => data[s.key] || s.key === docType);
  if (realised.length <= 1) return null;

  return (
    <nav
      aria-label="Document lifecycle"
      className={cn(
        "flex flex-wrap items-center gap-1 rounded-md border bg-muted/20 p-2",
        className,
      )}
    >
      {realised.map((step, i) => {
        const node = data[step.key];
        const isCurrent = step.key === docType;
        const Icon = step.icon;

        const content = (
          <span
            className={cn(
              "flex min-w-0 items-center gap-2 rounded px-2 py-1.5 text-xs transition-colors",
              isCurrent
                ? "bg-background font-semibold shadow-sm ring-1 ring-border"
                : node
                  ? "hover:bg-background"
                  : "opacity-45",
            )}
          >
            <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <span className="min-w-0">
              <span className="block truncate leading-tight">{step.label}</span>
              {node?.number && (
                <span className="block truncate font-mono text-[10px] font-normal leading-tight text-muted-foreground">
                  {node.number}
                  {!dense && node.status
                    ? ` · ${documentStatusLabel(step.kind, node.status)}`
                    : ""}
                </span>
              )}
            </span>
          </span>
        );

        return (
          <Fragment key={step.key}>
            {i > 0 && (
              <ChevronRight
                className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50"
                aria-hidden
              />
            )}
            {node && !isCurrent ? (
              <Link to={step.path(node.id)} className="min-w-0">
                {content}
              </Link>
            ) : (
              content
            )}
          </Fragment>
        );
      })}
    </nav>
  );
}
