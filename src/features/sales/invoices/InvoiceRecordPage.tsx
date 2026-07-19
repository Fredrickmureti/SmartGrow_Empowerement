/**
 * InvoiceRecordPage — the object-page route for a Sales Invoice.
 *
 * First adopter of the Phase-1 Sales record standard: composes
 * RecordShell + RecordHeader + Section + LineItemsGrid +
 * DocumentTotalsPanel + DocumentActivityPanel. Read-only for this
 * cycle; edit/create/convert flows land in follow-up passes per
 * docs/design-system/audit/sales.md.
 */

import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { format } from "date-fns";
import { ArrowLeft, Pencil, Printer } from "lucide-react";

import {
  ActionBar,
  ErrorState,
  FooterActionBar,
  LoadingState,
  RecordHeader,
  RecordShell,
  Section,
  StatusBadge,
  SummaryPanel,
} from "@/design-system";
import {
  DocumentActivityPanel,
  DocumentTotalsPanel,
  LineItemsGrid,
  type LineItemColumn,
  type LineItemRow,
} from "@/features/sales/record";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useCurrency } from "@/hooks/useCurrency";
import type { Invoice } from "@/hooks/useInvoices";
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

export default function InvoiceRecordPage() {
  const { id = "" } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { formatCurrency } = useCurrency();
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const isNew = id === "new";

  useEffect(() => {
    if (isNew) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      const { data, error: err } = await supabase
        .from("invoices")
        .select(
          "*, contact:contacts(name, email, phone), invoice_items(*)",
        )
        .eq("id", id)
        .maybeSingle();
      if (cancelled) return;
      if (err) setError(err.message);
      else if (!data) setError("Invoice not found.");
      else setInvoice(data as unknown as Invoice);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [id, isNew]);

  const columns = useMemo<LineItemColumn[]>(
    () => [
      { id: "description", header: "Description", width: "minmax(0,1fr)" },
      { id: "qty", header: "Qty", width: "80px", numeric: true },
      { id: "unit", header: "Unit price", width: "120px", numeric: true },
      { id: "disc", header: "Disc %", width: "80px", numeric: true, hideOnMobile: true },
      { id: "tax", header: "Tax %", width: "80px", numeric: true, hideOnMobile: true },
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
          { columnId: "disc", content: line.discount_percent ?? 0 },
          { columnId: "tax", content: line.tax_rate ?? 0 },
          { columnId: "total", content: formatCurrency(line.line_total ?? 0) },
        ],
      }));
  }, [invoice, formatCurrency]);

  if (isNew) {
    return (
      <RecordShell
        header={
          <RecordHeader
            eyebrow="Sales Invoice"
            title="New invoice"
            actions={
              <ActionBar>
                <Button variant="outline" size="sm" onClick={() => navigate("/sales/invoices")}>
                  <ArrowLeft className="mr-2 h-4 w-4" /> Back to list
                </Button>
              </ActionBar>
            }
          />
        }
      >
        <Section title="Create flow pending migration">
          <p className="text-sm text-muted-foreground">
            The invoice creation wizard is scheduled next in the Sales record
            migration. For now, use the <strong>New Invoice</strong> action on
            the{" "}
            <Link className="underline" to="/sales/invoices">
              Invoices list
            </Link>
            .
          </p>
        </Section>
      </RecordShell>
    );
  }

  if (loading) {
    return (
      <RecordShell
        header={<RecordHeader eyebrow="Sales Invoice" title="Loading…" />}
      >
        <Section>
          <LoadingState />
        </Section>
      </RecordShell>
    );
  }

  if (error || !invoice) {
    return (
      <RecordShell
        header={<RecordHeader eyebrow="Sales Invoice" title="Invoice" />}
      >
        <Section>
          <ErrorState
            title="Unable to load invoice"
            description={error ?? "Unknown error."}
            onRetry={() => navigate("/sales/invoices")}
          />
        </Section>
      </RecordShell>
    );
  }

  const status = invoice.status;
  const balance = Math.max(0, (invoice.total ?? 0) - (invoice.amount_paid ?? 0));

  return (
    <RecordShell
      header={
        <RecordHeader
          eyebrow="Sales Invoice"
          title={invoice.contact?.name ?? "Customer"}
          docNumber={invoice.invoice_number}
          status={
            <StatusBadge tone={STATUS_TONE[status]}>
              {STATUS_LABEL[status]}
            </StatusBadge>
          }
          meta={
            <>
              <span>Issued {fmtDate(invoice.issue_date)}</span>
              <span>Due {fmtDate(invoice.due_date)}</span>
              <span className="tabular-nums">
                {formatCurrency(invoice.total ?? 0)} {invoice.currency}
              </span>
            </>
          }
          actions={
            <ActionBar>
              <Button variant="outline" size="sm" onClick={() => navigate("/sales/invoices")}>
                <ArrowLeft className="mr-2 h-4 w-4" /> Back
              </Button>
              <Button variant="outline" size="sm" disabled>
                <Printer className="mr-2 h-4 w-4" /> Print
              </Button>
              <Button size="sm" disabled title="Editing still uses the list dialog while migration is in progress">
                <Pencil className="mr-2 h-4 w-4" /> Edit
              </Button>
            </ActionBar>
          }
        />
      }
      aside={
        <SummaryPanel>
          <DocumentTotalsPanel
            rows={[
              { label: "Subtotal", value: formatCurrency(invoice.subtotal ?? 0) },
              { label: "Discount", value: `- ${formatCurrency(invoice.discount_amount ?? 0)}`, muted: true },
              { label: "Tax", value: formatCurrency(invoice.tax_amount ?? 0) },
              { label: "Total", value: formatCurrency(invoice.total ?? 0), emphasized: true },
              { label: "Paid", value: formatCurrency(invoice.amount_paid ?? 0), muted: true },
              { label: "Balance due", value: formatCurrency(balance), emphasized: true },
            ]}
            footer={`Currency ${invoice.currency}`}
          />
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
        </SummaryPanel>
      }
      footer={
        <FooterActionBar
          trailing={
            <Button variant="outline" onClick={() => navigate("/sales/invoices")}>
              Close
            </Button>
          }
        />
      }
    >
      <Section title="Details">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <dt className="text-xs font-medium text-muted-foreground">Customer</dt>
            <dd className="mt-0.5">{invoice.contact?.name ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-muted-foreground">Email</dt>
            <dd className="mt-0.5">{invoice.contact?.email ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-muted-foreground">Phone</dt>
            <dd className="mt-0.5">{invoice.contact?.phone ?? "—"}</dd>
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
        </dl>
      </Section>

      <Section title="Line items">
        <LineItemsGrid columns={columns} rows={rows} readOnly />
      </Section>

      {(invoice.notes || invoice.terms) && (
        <Section title="Notes & terms">
          {invoice.notes && (
            <div className="mb-3">
              <div className="mb-1 text-xs font-medium text-muted-foreground">Notes</div>
              <p className="whitespace-pre-wrap text-sm">{invoice.notes}</p>
            </div>
          )}
          {invoice.terms && (
            <div>
              <div className="mb-1 text-xs font-medium text-muted-foreground">Terms</div>
              <p className="whitespace-pre-wrap text-sm">{invoice.terms}</p>
            </div>
          )}
        </Section>
      )}

      <DocumentVersionsSection documentType="invoice" documentId={invoice.id} />
    </RecordShell>
  );
}
