/**
 * BillRecordPage — object-page route for a Bill.
 *
 * Second Purchases record adopter (mirrors PurchaseOrderRecordPage).
 * Read-only in this pass; `EditBillDialog` remains the editor until the
 * Bills wizard slice lands.
 */

import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { format } from "date-fns";
import { ArrowLeft, Pencil, Printer, Link2 } from "lucide-react";
import { toast } from "sonner";

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
} from "@/features/documents";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useCurrency } from "@/hooks/useCurrency";
import type { Bill } from "@/hooks/useBills";

const STATUS_TONE: Record<
  string,
  "neutral" | "info" | "success" | "warning" | "danger" | "accent"
> = {
  draft: "neutral",
  received: "info",
  partial: "warning",
  paid: "success",
  overdue: "danger",
  void: "neutral",
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

export default function BillRecordPage() {
  const { id = "" } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { formatCurrency } = useCurrency();
  const [bill, setBill] = useState<Bill | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [matching, setMatching] = useState(false);

  const handleMatchReceipts = async () => {
    if (!bill?.id) return;
    setMatching(true);
    try {
      // ADR 0077 · 3-way match — RPC auto-links bill lines to open GRN
      // lines by (bill_id → PO → GRN → item) and records unit-cost
      // variances into bill_grn_matches. Idempotent on re-run.
      const { data, error: err } = await supabase.rpc("match_bill_to_grn", {
        p_bill_id: bill.id,
      });
      if (err) throw err;
      const count = typeof data === "number" ? data : 0;
      toast.success(
        count > 0
          ? `Matched ${count} bill line${count === 1 ? "" : "s"} to receipts`
          : "No new lines to match — bill is fully reconciled or has no PO link.",
      );
    } catch (err) {
      toast.error(`Match failed: ${(err as Error).message}`);
    } finally {
      setMatching(false);
    }
  };

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
        .from("bills")
        .select("*, vendor:contacts(name), items:bill_items(*)")
        .eq("id", id)
        .maybeSingle();
      if (cancelled) return;
      if (err) setError(err.message);
      else if (!data) setError("Bill not found.");
      else setBill(data as unknown as Bill);
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
      { id: "tax", header: "Tax %", width: "80px", numeric: true, hideOnMobile: true },
      { id: "total", header: "Subtotal", width: "120px", numeric: true },
    ],
    [],
  );

  const rows = useMemo<LineItemRow[]>(() => {
    const items = bill?.items ?? [];
    return items
      .slice()
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
      .map((line, idx) => ({
        id: line.id ?? String(idx),
        cells: [
          { columnId: "description", content: line.description || "—" },
          { columnId: "qty", content: line.quantity },
          { columnId: "unit", content: formatCurrency(line.unit_price ?? 0) },
          { columnId: "tax", content: line.tax_rate ?? 0 },
          { columnId: "total", content: formatCurrency(line.line_total ?? 0) },
        ],
      }));
  }, [bill, formatCurrency]);

  if (isNew) {
    return (
      <RecordShell
        header={
          <RecordHeader
            eyebrow="Bill"
            title="New bill"
            actions={
              <ActionBar>
                <Button variant="outline" size="sm" onClick={() => navigate("/purchases/bills")}>
                  <ArrowLeft className="mr-2 h-4 w-4" /> Back to list
                </Button>
              </ActionBar>
            }
          />
        }
      >
        <Section title="Create flow pending migration">
          <p className="text-sm text-muted-foreground">
            The bill creation wizard is scheduled in the Purchases record
            migration. For now, use the <strong>New Bill</strong> action on
            the{" "}
            <Link className="underline" to="/purchases/bills">
              Bills list
            </Link>
            .
          </p>
        </Section>
      </RecordShell>
    );
  }

  if (loading) {
    return (
      <RecordShell header={<RecordHeader eyebrow="Bill" title="Loading…" />}>
        <Section>
          <LoadingState />
        </Section>
      </RecordShell>
    );
  }

  if (error || !bill) {
    return (
      <RecordShell header={<RecordHeader eyebrow="Bill" title="Bill" />}>
        <Section>
          <ErrorState
            title="Unable to load bill"
            description={error ?? "Unknown error."}
            onRetry={() => navigate("/purchases/bills")}
          />
        </Section>
      </RecordShell>
    );
  }

  const tone = STATUS_TONE[bill.status] ?? "neutral";
  const balance = (bill.total ?? 0) - (bill.amount_paid ?? 0);

  return (
    <RecordShell
      header={
        <RecordHeader
          eyebrow="Bill"
          title={bill.vendor?.name ?? "Vendor"}
          docNumber={bill.bill_number}
          status={<StatusBadge tone={tone}>{formatStatus(bill.status)}</StatusBadge>}
          meta={
            <>
              <span>Billed {fmtDate(bill.bill_date)}</span>
              <span>Due {fmtDate(bill.due_date)}</span>
              <span className="tabular-nums">
                {formatCurrency(bill.total ?? 0)} {bill.currency}
              </span>
            </>
          }
          actions={
            <ActionBar>
              <Button variant="outline" size="sm" onClick={() => navigate("/purchases/bills")}>
                <ArrowLeft className="mr-2 h-4 w-4" /> Back
              </Button>
              <Button variant="outline" size="sm" disabled>
                <Printer className="mr-2 h-4 w-4" /> Print
              </Button>
              <Button
                size="sm"
                disabled
                title="Editing still uses the list dialog while migration is in progress"
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
              { label: "Subtotal", value: formatCurrency(bill.subtotal ?? 0) },
              { label: "Discount", value: `- ${formatCurrency(bill.discount_amount ?? 0)}`, muted: true },
              { label: "Tax", value: formatCurrency(bill.tax_amount ?? 0) },
              { label: "Total", value: formatCurrency(bill.total ?? 0), emphasized: true },
              { label: "Paid", value: formatCurrency(bill.amount_paid ?? 0), muted: true },
              { label: "Balance due", value: formatCurrency(balance), emphasized: true },
            ]}
            footer={`Currency ${bill.currency}`}
          />
          <DocumentActivityPanel
            entries={[
              {
                id: "created",
                at: fmtDate(bill.created_at),
                actor: "System",
                title: `Bill ${bill.bill_number} created`,
              },
            ]}
          />
        </SummaryPanel>
      }
      footer={
        <FooterActionBar
          trailing={
            <Button variant="outline" onClick={() => navigate("/purchases/bills")}>
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
            <dd className="mt-0.5">{bill.vendor?.name ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-muted-foreground">Vendor invoice #</dt>
            <dd className="mt-0.5">{bill.vendor_invoice_number ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-muted-foreground">Bill date</dt>
            <dd className="mt-0.5">{fmtDate(bill.bill_date)}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-muted-foreground">Due date</dt>
            <dd className="mt-0.5">{fmtDate(bill.due_date)}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-muted-foreground">Currency</dt>
            <dd className="mt-0.5">
              {bill.currency}
              {bill.currency_rate && bill.currency_rate !== 1
                ? ` @ ${bill.currency_rate}`
                : ""}
            </dd>
          </div>
        </dl>
      </Section>

      <Section title="Line items">
        <LineItemsGrid columns={columns} rows={rows} readOnly />
      </Section>

      {bill.notes && (
        <Section title="Notes">
          <p className="whitespace-pre-wrap text-sm">{bill.notes}</p>
        </Section>
      )}
    </RecordShell>
  );
}