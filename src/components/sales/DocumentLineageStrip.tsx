import { useQuery } from "@tanstack/react-query";
import { ChevronRight, FileText, Receipt, Truck, ScrollText, ClipboardList } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type LineageDocType =
  | "estimate"
  | "proforma_invoice"
  | "sales_order"
  | "delivery_note"
  | "invoice";

interface LineageNode {
  id: string;
  number: string | null;
  status: string | null;
  date: string | null;
}

interface LineageResponse {
  estimate?: LineageNode | null;
  proforma_invoice?: LineageNode | null;
  sales_order?: LineageNode | null;
  delivery_note?: LineageNode | null;
  invoice?: LineageNode | null;
  error?: string;
}

const STEPS: Array<{
  key: keyof Omit<LineageResponse, "error">;
  label: string;
  icon: typeof FileText;
}> = [
  { key: "estimate", label: "Estimate", icon: ClipboardList },
  { key: "proforma_invoice", label: "Proforma", icon: ScrollText },
  { key: "sales_order", label: "Sales Order", icon: FileText },
  { key: "delivery_note", label: "Delivery", icon: Truck },
  { key: "invoice", label: "Invoice", icon: Receipt },
];

interface Props {
  docType: LineageDocType;
  docId: string;
  className?: string;
}

export function DocumentLineageStrip({ docType, docId, className }: Props) {
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
    staleTime: 30_000,
  });

  if (isLoading) {
    return <Skeleton className={cn("h-10 w-full", className)} />;
  }
  if (!data || data.error) return null;

  const present = STEPS.filter((s) => data[s.key]);
  if (present.length <= 1) return null;

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-1.5 rounded-md border bg-muted/30 px-3 py-2 text-xs",
        className,
      )}
      aria-label="Document lineage"
    >
      {present.map((step, idx) => {
        const node = data[step.key]!;
        const Icon = step.icon;
        const isCurrent =
          (docType === step.key) ||
          (docType === "proforma_invoice" && step.key === "proforma_invoice");
        return (
          <div key={step.key} className="flex items-center gap-1.5">
            <div
              className={cn(
                "flex items-center gap-1.5 rounded px-2 py-1",
                isCurrent ? "bg-primary/10 text-primary font-medium" : "text-muted-foreground",
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              <span>{step.label}</span>
              {node.number && (
                <span className="font-mono text-[11px] opacity-80">{node.number}</span>
              )}
              {node.status && (
                <Badge variant="outline" className="h-4 px-1 text-[10px]">
                  {node.status}
                </Badge>
              )}
            </div>
            {idx < present.length - 1 && (
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/50" />
            )}
          </div>
        );
      })}
    </div>
  );
}
