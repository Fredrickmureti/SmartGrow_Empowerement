/**
 * SalesOrderRecordPage — object-page route for a Sales Order.
 *
 * Third Sales record adopter of the Phase-1 standard. Read-only in this
 * cycle; create/edit/convert/fulfillment flows migrate to WizardShell
 * in follow-up passes per docs/design-system/audit/sales.md.
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
} from "@/design-system/records";
import { useRecordPrint } from "@/features/sales/record/useRecordPrint";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useCurrency } from "@/hooks/useCurrency";
import type { SalesOrder } from "@/hooks/useSalesOrders";
import { DocumentVersionsSection } from "@/components/documents/DocumentVersionsSection";

const STATUS_TONE: Record<
  string,
  "neutral" | "info" | "success" | "warning" | "danger" | "accent"
> = {
  draft: "neutral",
  pending_approval: "warning",
  approved: "info",
  confirmed: "info",
  partial: "warning",
  fulfilled: "success",
  invoiced: "success",
  cancelled: "neutral",
  rejected: "danger",
};

function fmtDate(v: string | null | undefined) {
  if (!v) return "—";
  try {
    return format(new Date(v), "PP");
  } catch {
    return v;
  }
}

function formatStatus(s: string) {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export default function SalesOrderRecordPage() {
  const { id = "" } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { formatCurrency } = useCurrency();
  const { print, printing } = useRecordPrint("sales_order");
  const [order, setOrder] = useState<SalesOrder | null>(null);
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
        .from("sales_orders")
        .select("*, contact:contacts(name, email), items:sales_order_items(*)")
        .eq("id", id)
        .maybeSingle();
      if (cancelled) return;
      if (err) setError(err.message);
      else if (!data) setError("Sales order not found.");
      else setOrder(data as unknown as SalesOrder);
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
      { id: "fulfilled", header: "Fulfilled", width: "90px", numeric: true, hideOnMobile: true },
      { id: "unit", header: "Unit price", width: "120px", numeric: true },
      { id: "disc", header: "Disc %", width: "80px", numeric: true, hideOnMobile: true },
      { id: "tax", header: "Tax %", width: "80px", numeric: true, hideOnMobile: true },
      { id: "total", header: "Subtotal", width: "120px", numeric: true },
    ],
    [],
  );

  const rows = useMemo<LineItemRow[]>(() => {
    const items = order?.items ?? [];
    return items
      .slice()
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
      .map((line, idx) => ({
        id: line.id ?? String(idx),
        cells: [
          { columnId: "description", content: line.description || "—" },
          { columnId: "qty", content: line.quantity },
          { columnId: "fulfilled", content: line.quantity_fulfilled ?? 0 },
          { columnId: "unit", content: formatCurrency(line.unit_price ?? 0) },
          { columnId: "disc", content: line.discount_percent ?? 0 },
          { columnId: "tax", content: line.tax_rate ?? 0 },
          { columnId: "total", content: formatCurrency(line.line_total ?? 0) },
        ],
      }));
  }, [order, formatCurrency]);

  if (isNew) {
    return (
      <RecordShell
        header={
          <RecordHeader
            eyebrow="Sales Order"
            title="New sales order"
            actions={
              <ActionBar>
                <Button variant="outline" size="sm" onClick={() => navigate("/sales/orders")}>
                  <ArrowLeft className="mr-2 h-4 w-4" /> Back to list
                </Button>
              </ActionBar>
            }
          />
        }
      >
        <Section title="Create flow pending migration">
          <p className="text-sm text-muted-foreground">
            The sales-order creation wizard is scheduled next in the Sales
            record migration. For now, use the <strong>New Order</strong>{" "}
            action on the{" "}
            <Link className="underline" to="/sales/orders">
              Sales orders list
            </Link>
            .
          </p>
        </Section>
      </RecordShell>
    );
  }

  if (loading) {
    return (
      <RecordShell header={<RecordHeader eyebrow="Sales Order" title="Loading…" />}>
        <Section>
          <LoadingState />
        </Section>
      </RecordShell>
    );
  }

  if (error || !order) {
    return (
      <RecordShell header={<RecordHeader eyebrow="Sales Order" title="Sales order" />}>
        <Section>
          <ErrorState
            title="Unable to load sales order"
            description={error ?? "Unknown error."}
            onRetry={() => navigate("/sales/orders")}
          />
        </Section>
      </RecordShell>
    );
  }

  const tone = STATUS_TONE[order.status] ?? "neutral";

  return (
    <RecordShell
      header={
        <RecordHeader
          eyebrow="Sales Order"
          title={order.contact?.name ?? "Customer"}
          docNumber={order.so_number}
          status={<StatusBadge tone={tone}>{formatStatus(order.status)}</StatusBadge>}
          meta={
            <>
              <span>Ordered {fmtDate(order.order_date)}</span>
              <span>Expected {fmtDate(order.expected_date)}</span>
              <span className="tabular-nums">
                {formatCurrency(order.total ?? 0)} {order.currency}
              </span>
            </>
          }
          actions={
            <ActionBar>
              <Button variant="outline" size="sm" onClick={() => navigate("/sales/orders")}>
                <ArrowLeft className="mr-2 h-4 w-4" /> Back
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={printing}
                onClick={() => void print(order.id, `Sales order ${order.so_number}`)}
              >
                <Printer className="mr-2 h-4 w-4" /> {printing ? "Printing…" : "Print"}
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
              { label: "Subtotal", value: formatCurrency(order.subtotal ?? 0) },
              { label: "Discount", value: `- ${formatCurrency(order.discount_amount ?? 0)}`, muted: true },
              { label: "Shipping", value: formatCurrency(order.shipping_amount ?? 0), muted: true },
              { label: "Tax", value: formatCurrency(order.tax_amount ?? 0) },
              { label: "Total", value: formatCurrency(order.total ?? 0), emphasized: true },
            ]}
            footer={`Currency ${order.currency}`}
          />
          <DocumentActivityPanel
            entries={[
              {
                id: "created",
                at: fmtDate(order.created_at),
                actor: "System",
                title: `Order ${order.so_number} created`,
              },
              ...(order.source_estimate_id
                ? [
                    {
                      id: "from-estimate",
                      at: fmtDate(order.created_at),
                      title: "Converted from estimate",
                      tone: "info" as const,
                    },
                  ]
                : []),
              ...(order.converted_at
                ? [
                    {
                      id: "converted",
                      at: fmtDate(order.converted_at),
                      title: "Invoiced",
                      tone: "success" as const,
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
            <Button variant="outline" onClick={() => navigate("/sales/orders")}>
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
            <dd className="mt-0.5">{order.contact?.name ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-muted-foreground">Email</dt>
            <dd className="mt-0.5">{order.contact?.email ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-muted-foreground">Order date</dt>
            <dd className="mt-0.5">{fmtDate(order.order_date)}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-muted-foreground">Expected date</dt>
            <dd className="mt-0.5">{fmtDate(order.expected_date)}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-muted-foreground">Currency</dt>
            <dd className="mt-0.5">{order.currency}</dd>
          </div>
          <div className="sm:col-span-2 lg:col-span-3">
            <dt className="text-xs font-medium text-muted-foreground">Shipping address</dt>
            <dd className="mt-0.5 whitespace-pre-wrap">{order.shipping_address ?? "—"}</dd>
          </div>
        </dl>
      </Section>

      <Section title="Line items">
        <LineItemsGrid columns={columns} rows={rows} readOnly />
      </Section>

      {order.notes && (
        <Section title="Notes">
          <p className="whitespace-pre-wrap text-sm">{order.notes}</p>
        </Section>
      )}

      <DocumentVersionsSection documentType="sales_order" documentId={order.id} />
    </RecordShell>
  );
}
