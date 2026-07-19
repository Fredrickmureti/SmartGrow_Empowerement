/**
 * InvoicePeekSheet — the standard Sales list peek surface for one invoice.
 *
 * Opens from `?peek=<id>` (via usePeekParam). Shares its data hook and
 * section vocabulary with InvoiceRecordPage so users see the same layout
 * language whether the record opens in the sheet or on its full page.
 *
 * All record-affecting actions (record payment, void, edit, send, etc.)
 * remain owned by the parent list's row action menu — the peek is
 * read-oriented context.
 */
import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { format } from "date-fns";
import { ArrowUpRight } from "lucide-react";

import {
  ActionBar,
  DetailSheet,
  ErrorState,
  FooterActionBar,
  LoadingState,
  Section,
  StatusBadge,
} from "@/design-system";
import {
  DocumentActivityPanel,
  DocumentTotalsPanel,
  LineItemsGrid,
  type LineItemColumn,
  type LineItemRow,
} from "@/features/sales/record";
import { Button } from "@/components/ui/button";
import { useCurrency } from "@/hooks/useCurrency";
import type { Invoice } from "@/hooks/useInvoices";
import { useInvoiceRecord } from "./useInvoiceRecord";
import { DocumentVersionsSection } from "@/components/documents/DocumentVersionsSection";

type InvoiceStatus = Invoice["status"];

const STATUS_TONE: Record<
  InvoiceStatus,
  "neutral" | "info" | "success" | "warning" | "danger" | "accent"
> = {
  draft: "neutral",
  confirmed: "info",
  sent: "info",
  viewed: "accent",
  partial: "warning",
  paid: "success",
  overdue: "danger",
  cancelled: "neutral",
  voided: "danger",
};

const STATUS_LABEL: Record<InvoiceStatus, string> = {
  draft: "Draft",
  confirmed: "Confirmed",
  sent: "Sent",
  viewed: "Viewed",
  partial: "Partial",
  paid: "Paid",
  overdue: "Overdue",
  cancelled: "Cancelled",
  voided: "Voided",
};

function fmtDate(v: string | null | undefined) {
  if (!v) return "—";
  try {
    return format(new Date(v), "PP");
  } catch {
    return v;
  }
}

interface InvoicePeekSheetProps {
  invoiceId: string | null;
  onOpenChange: (open: boolean) => void;
}

export function InvoicePeekSheet({ invoiceId, onOpenChange }: InvoicePeekSheetProps) {
  const open = !!invoiceId;
  const { invoice, loading, error } = useInvoiceRecord(invoiceId);
  const { formatCurrency } = useCurrency();
  const navigate = useNavigate();

  const columns = useMemo<LineItemColumn[]>(
    () => [
      { id: "description", header: "Description", width: "minmax(0,1fr)" },
      { id: "qty", header: "Qty", width: "64px", numeric: true },
      { id: "unit", header: "Unit", width: "110px", numeric: true },
      { id: "total", header: "Subtotal", width: "120px", numeric: true },
    ],
    [],
  );

  const rows = useMemo<LineItemRow[]>(() => {
    const items = invoice?.invoice_items ?? [];
    return items
      .slice()
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
      .map((line, idx) => ({
        id: line.id ?? String(idx),
        cells: [
          { columnId: "description", content: line.description || "—" },
          { columnId: "qty", content: line.quantity },
          { columnId: "unit", content: formatCurrency(line.unit_price ?? 0) },
          { columnId: "total", content: formatCurrency(line.line_total ?? 0) },
        ],
      }));
  }, [invoice, formatCurrency]);

  const balance = invoice
    ? Math.max(0, (invoice.total ?? 0) - (invoice.amount_paid ?? 0))
    : 0;

  return (
    <DetailSheet
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={
        loading
          ? "Loading invoice…"
          : invoice
            ? `Invoice ${invoice.invoice_number}`
            : "Invoice"
      }
      description={
        invoice ? (
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge tone={STATUS_TONE[invoice.status]}>
              {STATUS_LABEL[invoice.status]}
            </StatusBadge>
            <span className="text-muted-foreground">
              {invoice.contact?.name ?? "Customer"}
            </span>
          </span>
        ) : undefined
      }
      headerActions={
        invoice ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              onOpenChange(false);
              navigate(`/sales/invoices/${invoice.id}`);
            }}
          >
            <ArrowUpRight className="mr-1.5 h-4 w-4" /> Open full page
          </Button>
        ) : null
      }
      footer={
        invoice ? (
          <FooterActionBar
            anchor="sheet"
            trailing={
              <ActionBar>
                <Button variant="outline" onClick={() => onOpenChange(false)}>
                  Close
                </Button>
                <Button
                  onClick={() => {
                    onOpenChange(false);
                    navigate(`/sales/invoices/${invoice.id}`);
                  }}
                >
                  Open full page
                </Button>
              </ActionBar>
            }
          />
        ) : null
      }
    >
      {loading && <LoadingState />}
      {!loading && error && (
        <ErrorState
          title="Unable to load invoice"
          description={error}
        />
      )}
      {!loading && invoice && (
        <div className="space-y-5">
          <Section title="Details">
            <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs font-medium text-muted-foreground">Customer</dt>
                <dd className="mt-0.5">{invoice.contact?.name ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-muted-foreground">Email</dt>
                <dd className="mt-0.5">{invoice.contact?.email ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-muted-foreground">Issue date</dt>
                <dd className="mt-0.5">{fmtDate(invoice.issue_date)}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-muted-foreground">Due date</dt>
                <dd className="mt-0.5">{fmtDate(invoice.due_date)}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-muted-foreground">Currency</dt>
                <dd className="mt-0.5">{invoice.currency}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-muted-foreground">Balance due</dt>
                <dd className="mt-0.5 tabular-nums">{formatCurrency(balance)}</dd>
              </div>
            </dl>
          </Section>

          <Section title="Totals">
            <DocumentTotalsPanel
              rows={[
                { label: "Subtotal", value: formatCurrency(invoice.subtotal ?? 0) },
                {
                  label: "Discount",
                  value: `- ${formatCurrency(invoice.discount_amount ?? 0)}`,
                  muted: true,
                },
                { label: "Tax", value: formatCurrency(invoice.tax_amount ?? 0) },
                {
                  label: "Total",
                  value: formatCurrency(invoice.total ?? 0),
                  emphasized: true,
                },
                {
                  label: "Paid",
                  value: formatCurrency(invoice.amount_paid ?? 0),
                  muted: true,
                },
                {
                  label: "Balance due",
                  value: formatCurrency(balance),
                  emphasized: true,
                },
              ]}
              footer={`Currency ${invoice.currency}`}
            />
          </Section>

          <Section title="Line items">
            <LineItemsGrid columns={columns} rows={rows} readOnly />
          </Section>

          <Section title="Activity">
            <DocumentActivityPanel
              entries={[
                {
                  id: "created",
                  at: fmtDate(invoice.created_at),
                  actor: "System",
                  title: `Invoice ${invoice.invoice_number} created`,
                },
                ...(invoice.confirmed_by
                  ? [
                      {
                        id: "confirmed",
                        at: fmtDate(invoice.updated_at),
                        title: "Invoice confirmed",
                        tone: "info" as const,
                      },
                    ]
                  : []),
              ]}
            />
          </Section>
          <DocumentVersionsSection documentType="invoice" documentId={invoiceId} />
        </div>
      )}
    </DetailSheet>
  );
}
