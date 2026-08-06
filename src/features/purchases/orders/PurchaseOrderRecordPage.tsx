/**
 * PurchaseOrderRecordPage — object-page route for a Purchase Order.
 *
 * First Purchases record adopter of the Phase-1 standard (mirrors
 * `SalesOrderRecordPage`). Read-only in this pass; the legacy
 * `EditPODialog` stays as the editor until the Purchases wizard slice
 * lands. New `/purchases/orders/:id` navigation now opens this full
 * page instead of the drawer.
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
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useCurrency } from "@/hooks/useCurrency";
import { DocumentVersionsSection } from "@/components/documents/DocumentVersionsSection";
import type { PurchaseOrder } from "@/hooks/usePurchaseOrders";

const STATUS_TONE: Record<
  string,
  "neutral" | "info" | "success" | "warning" | "danger" | "accent"
> = {
  draft: "neutral",
  sent: "info",
  partial_received: "warning",
  received: "success",
  cancelled: "neutral",
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

export default function PurchaseOrderRecordPage() {
  const { id = "" } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { formatCurrency } = useCurrency();
  const [po, setPo] = useState<PurchaseOrder | null>(null);
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
        .from("purchase_orders")
        .select("*, vendor:contacts(name), items:purchase_order_items(*)")
        .eq("id", id)
        .maybeSingle();
      if (cancelled) return;
      if (err) setError(err.message);
      else if (!data) setError("Purchase order not found.");
      else setPo(data as unknown as PurchaseOrder);
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
      { id: "received", header: "Received", width: "90px", numeric: true, hideOnMobile: true },
      { id: "unit", header: "Unit price", width: "120px", numeric: true },
      { id: "tax", header: "Tax %", width: "80px", numeric: true, hideOnMobile: true },
      { id: "total", header: "Subtotal", width: "120px", numeric: true },
    ],
    [],
  );

  const rows = useMemo<LineItemRow[]>(() => {
    const items = po?.items ?? [];
    return items
      .slice()
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
      .map((line, idx) => ({
        id: line.id ?? String(idx),
        cells: [
          { columnId: "description", content: line.description || "—" },
          { columnId: "qty", content: line.quantity },
          { columnId: "received", content: line.quantity_received ?? 0 },
          { columnId: "unit", content: formatCurrency(line.unit_price ?? 0) },
          { columnId: "tax", content: line.tax_rate ?? 0 },
          { columnId: "total", content: formatCurrency(line.line_total ?? 0) },
        ],
      }));
  }, [po, formatCurrency]);

  if (isNew) {
    return (
      <RecordShell
        header={
          <RecordHeader
            eyebrow="Purchase Order"
            title="New purchase order"
            actions={
              <ActionBar>
                <Button variant="outline" size="sm" onClick={() => navigate("/purchases/orders")}>
                  <ArrowLeft className="mr-2 h-4 w-4" /> Back to list
                </Button>
              </ActionBar>
            }
          />
        }
      >
        <Section title="Create flow pending migration">
          <p className="text-sm text-muted-foreground">
            The purchase-order creation wizard is scheduled in the Purchases
            record migration. For now, use the <strong>New PO</strong>{" "}
            action on the{" "}
            <Link className="underline" to="/purchases/orders">
              Purchase orders list
            </Link>
            .
          </p>
        </Section>
      </RecordShell>
    );
  }

  if (loading) {
    return (
      <RecordShell header={<RecordHeader eyebrow="Purchase Order" title="Loading…" />}>
        <Section>
          <LoadingState />
        </Section>
      </RecordShell>
    );
  }

  if (error || !po) {
    return (
      <RecordShell header={<RecordHeader eyebrow="Purchase Order" title="Purchase order" />}>
        <Section>
          <ErrorState
            title="Unable to load purchase order"
            description={error ?? "Unknown error."}
            onRetry={() => navigate("/purchases/orders")}
          />
        </Section>
      </RecordShell>
    );
  }

  const tone = STATUS_TONE[po.status] ?? "neutral";

  return (
    <RecordShell
      header={
        <RecordHeader
          eyebrow="Purchase Order"
          title={po.vendor?.name ?? "Vendor"}
          docNumber={po.po_number}
          status={<StatusBadge tone={tone}>{formatStatus(po.status)}</StatusBadge>}
          meta={
            <>
              <span>Ordered {fmtDate(po.order_date)}</span>
              <span>Expected {fmtDate(po.expected_date)}</span>
              <span className="tabular-nums">
                {formatCurrency(po.total ?? 0)} {po.currency}
              </span>
            </>
          }
          actions={
            <ActionBar>
              <Button variant="outline" size="sm" onClick={() => navigate("/purchases/orders")}>
                <ArrowLeft className="mr-2 h-4 w-4" /> Back
              </Button>
              <Button variant="outline" size="sm" disabled>
                <Printer className="mr-2 h-4 w-4" /> Print
              </Button>
              <Button
                size="sm"
                onClick={() => navigate(`/purchases/orders/${po.id}/edit`)}
              >
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
              { label: "Subtotal", value: formatCurrency(po.subtotal ?? 0) },
              { label: "Discount", value: `- ${formatCurrency(po.discount_amount ?? 0)}`, muted: true },
              { label: "Tax", value: formatCurrency(po.tax_amount ?? 0) },
              { label: "Total", value: formatCurrency(po.total ?? 0), emphasized: true },
            ]}
            footer={`Currency ${po.currency}`}
          />
          <DocumentActivityPanel
            entries={[
              {
                id: "created",
                at: fmtDate(po.created_at),
                actor: "System",
                title: `PO ${po.po_number} created`,
              },
              ...(po.converted_at
                ? [
                    {
                      id: "converted",
                      at: fmtDate(po.converted_at),
                      title: "Converted to bill",
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
            <Button variant="outline" onClick={() => navigate("/purchases/orders")}>
              Close
            </Button>
          }
        />
      }
    >
      <Section title="Details">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <dt className="text-xs font-medium text-muted-foreground">Vendor</dt>
            <dd className="mt-0.5">{po.vendor?.name ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-muted-foreground">Order date</dt>
            <dd className="mt-0.5">{fmtDate(po.order_date)}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-muted-foreground">Expected date</dt>
            <dd className="mt-0.5">{fmtDate(po.expected_date)}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-muted-foreground">Currency</dt>
            <dd className="mt-0.5">{po.currency}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-muted-foreground">Billing status</dt>
            <dd className="mt-0.5">{formatStatus(po.billing_status ?? "no")}</dd>
          </div>
          <div className="sm:col-span-2 lg:col-span-3">
            <dt className="text-xs font-medium text-muted-foreground">Shipping address</dt>
            <dd className="mt-0.5 whitespace-pre-wrap">{po.shipping_address ?? "—"}</dd>
          </div>
        </dl>
      </Section>

      <Section title="Line items">
        <LineItemsGrid columns={columns} rows={rows} readOnly />
      </Section>

      {po.notes && (
        <Section title="Notes">
          <p className="whitespace-pre-wrap text-sm">{po.notes}</p>
        </Section>
      )}

      <DocumentVersionsSection documentType="purchase_order" documentId={po.id} />
    </RecordShell>
  );
}