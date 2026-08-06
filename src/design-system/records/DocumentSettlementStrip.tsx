/**
 * DocumentSettlementStrip — the downstream half of the order-to-cash chain.
 *
 * `DocumentLifecycleStrip` walks the *origination* spine (quotation →
 * proforma → order → delivery → invoice). Once a document is invoiced the
 * questions a controller asks change: was it paid, was it posted, was the
 * cash reconciled, was it credited or returned, and is it now a collections
 * problem. This strip answers those, sourced from
 * `get_document_settlement_lineage`.
 *
 * Downstream steps are *cardinal* — an invoice can carry many payments and
 * many credit notes — so each node shows a count and expands into a linked
 * list, rather than pretending the chain is one document deep. Steps that
 * have not happened render dimmed: on an unpaid invoice, "no payment yet" is
 * the most valuable fact on the page.
 */
import { Fragment, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  AlertTriangle,
  BookOpen,
  ChevronRight,
  Landmark,
  Receipt,
  RotateCcw,
  Undo2,
} from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { documentStatusLabel, type DocumentKind } from "./documentStatus";

interface SettlementNode {
  id: string;
  number: string | null;
  status: string | null;
  date: string | null;
  amount?: number | null;
}

interface CollectionsPosition {
  balance: number | null;
  currency: string | null;
  due_date: string | null;
  days_overdue: number | null;
  status: string | null;
}

interface SettlementLineage {
  payments?: SettlementNode[];
  journal_entry?: SettlementNode | null;
  reconciliation?: { matched: number; pending: number } | null;
  credit_notes?: SettlementNode[];
  returns?: SettlementNode[];
  collections?: CollectionsPosition | null;
  error?: string;
}

type SettlementKey =
  | "payment"
  | "journal_entry"
  | "reconciliation"
  | "credit_note"
  | "sales_return"
  | "collections";

interface StepView {
  key: SettlementKey;
  label: string;
  icon: typeof Receipt;
  kind?: DocumentKind;
  nodes: SettlementNode[];
  /** Rendered under the label when the step carries no documents. */
  caption?: string;
  path?: (id: string) => string;
  tone?: "danger";
}

function buildSteps(data: SettlementLineage): StepView[] {
  const payments = data.payments ?? [];
  const creditNotes = data.credit_notes ?? [];
  const returns = data.returns ?? [];
  const recon = data.reconciliation ?? { matched: 0, pending: 0 };
  const collections = data.collections ?? null;
  const overdue = (collections?.days_overdue ?? 0) > 0;

  return [
    {
      key: "payment",
      label: "Payments",
      icon: Receipt,
      kind: "customer_payment",
      nodes: payments,
      path: (id) => `/sales/payments/${id}`,
    },
    {
      key: "journal_entry",
      label: "Journal Entry",
      icon: BookOpen,
      kind: "journal_entry",
      nodes: data.journal_entry ? [data.journal_entry] : [],
      path: (id) => `/finance/journal-entries/${id}`,
    },
    {
      key: "reconciliation",
      label: "Reconciliation",
      icon: Landmark,
      nodes: [],
      caption:
        recon.matched + recon.pending === 0
          ? undefined
          : recon.pending > 0
            ? `${recon.matched} matched · ${recon.pending} pending`
            : `${recon.matched} matched`,
    },
    {
      key: "credit_note",
      label: "Credit Notes",
      icon: Undo2,
      kind: "credit_note",
      nodes: creditNotes,
      path: (id) => `/sales/credit-notes/${id}`,
    },
    {
      key: "sales_return",
      label: "Returns",
      icon: RotateCcw,
      kind: "sales_return",
      nodes: returns,
      path: (id) => `/sales/returns/${id}`,
    },
    {
      key: "collections",
      label: "Collections",
      icon: AlertTriangle,
      nodes: [],
      caption: overdue
        ? `${collections?.days_overdue} days overdue`
        : undefined,
      tone: overdue ? "danger" : undefined,
    },
  ];
}

interface Props {
  /** Only invoices carry a settlement chain today. */
  docType: string;
  docId: string;
  className?: string;
  dense?: boolean;
}

export function DocumentSettlementStrip({
  docType,
  docId,
  className,
  dense,
}: Props) {
  const [expanded, setExpanded] = useState<SettlementKey | null>(null);
  const enabled = docType === "invoice" && !!docId;

  const { data, isLoading } = useQuery({
    queryKey: ["document-settlement-lineage", docType, docId],
    queryFn: async (): Promise<SettlementLineage> => {
      const { data, error } = await supabase.rpc(
        "get_document_settlement_lineage",
        { p_doc_type: docType, p_doc_id: docId },
      );
      if (error) throw error;
      return (data ?? {}) as SettlementLineage;
    },
    enabled,
    staleTime: 60_000,
  });

  if (!enabled) return null;
  if (isLoading) return <Skeleton className={cn("h-12 w-full", className)} />;
  if (!data || data.error) return null;

  const steps = buildSteps(data);
  const open = steps.find((s) => s.key === expanded && s.nodes.length > 0);

  return (
    <div className={className}>
      <nav
        aria-label="Settlement lifecycle"
        className="flex flex-wrap items-center gap-1 rounded-md border bg-muted/20 p-2"
      >
        {steps.map((step, i) => {
          const Icon = step.icon;
          const count = step.nodes.length;
          const realised = count > 0 || !!step.caption;
          const isOpen = expanded === step.key;

          const body = (
            <span className="flex min-w-0 items-center gap-2">
              <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
              <span className="min-w-0 text-left">
                <span className="block truncate leading-tight">
                  {step.label}
                  {count > 1 ? ` (${count})` : ""}
                </span>
                {!dense && (step.caption || count === 1) && (
                  <span className="block truncate font-mono text-[10px] font-normal leading-tight text-muted-foreground">
                    {step.caption ??
                      [
                        step.nodes[0]?.number,
                        step.kind && step.nodes[0]?.status
                          ? documentStatusLabel(step.kind, step.nodes[0].status)
                          : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                  </span>
                )}
              </span>
            </span>
          );

          const classes = cn(
            "flex min-w-0 items-center gap-2 rounded px-2 py-1.5 text-xs transition-colors",
            !realised && "opacity-45",
            realised && "hover:bg-background",
            isOpen && "bg-background shadow-sm ring-1 ring-border",
            step.tone === "danger" && "text-destructive",
          );

          return (
            <Fragment key={step.key}>
              {i > 0 && (
                <ChevronRight
                  className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50"
                  aria-hidden
                />
              )}
              {count > 0 && step.path ? (
                <button
                  type="button"
                  className={classes}
                  aria-expanded={isOpen}
                  onClick={() => setExpanded(isOpen ? null : step.key)}
                >
                  {body}
                </button>
              ) : (
                <span className={classes}>{body}</span>
              )}
            </Fragment>
          );
        })}
      </nav>

      {open?.path && (
        <ul className="mt-1 space-y-0.5 rounded-md border bg-background p-2 text-xs">
          {open.nodes.map((node) => (
            <li key={node.id}>
              <Link
                to={open.path!(node.id)}
                className="flex items-center justify-between gap-3 rounded px-2 py-1 hover:bg-muted"
              >
                <span className="min-w-0 truncate font-mono">
                  {node.number ?? node.id.slice(0, 8)}
                </span>
                <span className="shrink-0 text-muted-foreground">
                  {[
                    node.date,
                    open.kind && node.status
                      ? documentStatusLabel(open.kind, node.status)
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
