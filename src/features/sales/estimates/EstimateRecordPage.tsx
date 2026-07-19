/**
 * EstimateRecordPage — object-page route for a Sales Estimate.
 *
 * Second Sales record adopter of the Phase-1 standard (after Invoices).
 * Read-only in this cycle; create/edit/convert flows land in follow-up
 * passes per docs/design-system/audit/sales.md.
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
import type { Estimate } from "@/hooks/useEstimates";
import { DocumentVersionsSection } from "@/components/documents/DocumentVersionsSection";

type EstimateStatus = Estimate["status"];

const STATUS_TONE: Record<
  EstimateStatus,
  "neutral" | "info" | "success" | "warning" | "danger" | "accent"
> = {
  draft: "neutral",
  sent: "info",
  viewed: "accent",
  accepted: "success",
  rejected: "danger",
  expired: "warning",
  converted: "success",
};

const STATUS_LABEL: Record<EstimateStatus, string> = {
  draft: "Draft",
  sent: "Sent",
  viewed: "Viewed",
  accepted: "Accepted",
  rejected: "Rejected",
  expired: "Expired",
  converted: "Converted",
};

function fmtDate(v: string | null | undefined) {
  if (!v) return "—";
  try {
    return format(new Date(v), "PP");
  } catch {
    return v;
  }
}

export default function EstimateRecordPage() {
  const { id = "" } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { formatCurrency } = useCurrency();
  const [estimate, setEstimate] = useState<Estimate | null>(null);
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
        .from("estimates")
        .select("*, contact:contacts(name, email), items:estimate_items(*)")
        .eq("id", id)
        .maybeSingle();
      if (cancelled) return;
      if (err) setError(err.message);
      else if (!data) setError("Estimate not found.");
      else setEstimate(data as unknown as Estimate);
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
    const items = estimate?.items ?? [];
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
  }, [estimate, formatCurrency]);

  if (isNew) {
    return (
      <RecordShell
        header={
          <RecordHeader
            eyebrow="Sales Estimate"
            title="New estimate"
            actions={
              <ActionBar>
                <Button variant="outline" size="sm" onClick={() => navigate("/sales/estimates")}>
                  <ArrowLeft className="mr-2 h-4 w-4" /> Back to list
                </Button>
              </ActionBar>
            }
          />
        }
      >
        <Section title="Create flow pending migration">
          <p className="text-sm text-muted-foreground">
            The estimate creation wizard is scheduled next in the Sales record
            migration. For now, use the <strong>New Estimate</strong> action on
            the{" "}
            <Link className="underline" to="/sales/estimates">
              Estimates list
            </Link>
            .
          </p>
        </Section>
      </RecordShell>
    );
  }

  if (loading) {
    return (
      <RecordShell header={<RecordHeader eyebrow="Sales Estimate" title="Loading…" />}>
        <Section>
          <LoadingState />
        </Section>
      </RecordShell>
    );
  }

  if (error || !estimate) {
    return (
      <RecordShell header={<RecordHeader eyebrow="Sales Estimate" title="Estimate" />}>
        <Section>
          <ErrorState
            title="Unable to load estimate"
            description={error ?? "Unknown error."}
            onRetry={() => navigate("/sales/estimates")}
          />
        </Section>
      </RecordShell>
    );
  }

  const status = estimate.status;

  return (
    <RecordShell
      header={
        <RecordHeader
          eyebrow="Sales Estimate"
          title={estimate.contact?.name ?? "Customer"}
          docNumber={estimate.estimate_number}
          status={
            <StatusBadge tone={STATUS_TONE[status]}>
              {STATUS_LABEL[status]}
            </StatusBadge>
          }
          meta={
            <>
              <span>Issued {fmtDate(estimate.issue_date)}</span>
              <span>Expires {fmtDate(estimate.expiry_date)}</span>
              <span className="tabular-nums">
                {formatCurrency(estimate.total ?? 0)} {estimate.currency}
              </span>
            </>
          }
          actions={
            <ActionBar>
              <Button variant="outline" size="sm" onClick={() => navigate("/sales/estimates")}>
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
              { label: "Subtotal", value: formatCurrency(estimate.subtotal ?? 0) },
              { label: "Discount", value: `- ${formatCurrency(estimate.discount_amount ?? 0)}`, muted: true },
              { label: "Tax", value: formatCurrency(estimate.tax_amount ?? 0) },
              { label: "Total", value: formatCurrency(estimate.total ?? 0), emphasized: true },
            ]}
            footer={`Currency ${estimate.currency}`}
          />
          <DocumentActivityPanel
            entries={[
              {
                id: "created",
                at: fmtDate(estimate.created_at),
                actor: "System",
                title: `Estimate ${estimate.estimate_number} created`,
              },
              ...(estimate.signed_at
                ? [
                    {
                      id: "signed",
                      at: fmtDate(estimate.signed_at),
                      title: `Signed by ${estimate.signed_by_name ?? "customer"}`,
                      tone: "success" as const,
                    },
                  ]
                : []),
              ...(estimate.converted_at
                ? [
                    {
                      id: "converted",
                      at: fmtDate(estimate.converted_at),
                      title: "Converted to invoice",
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
            <Button variant="outline" onClick={() => navigate("/sales/estimates")}>
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
            <dd className="mt-0.5">{estimate.contact?.name ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-muted-foreground">Email</dt>
            <dd className="mt-0.5">{estimate.contact?.email ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-muted-foreground">Issue date</dt>
            <dd className="mt-0.5">{fmtDate(estimate.issue_date)}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-muted-foreground">Expiry date</dt>
            <dd className="mt-0.5">{fmtDate(estimate.expiry_date)}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-muted-foreground">Currency</dt>
            <dd className="mt-0.5">{estimate.currency}</dd>
          </div>
        </dl>
      </Section>

      <Section title="Line items">
        <LineItemsGrid columns={columns} rows={rows} readOnly />
      </Section>

      {(estimate.notes || estimate.terms) && (
        <Section title="Notes & terms">
          {estimate.notes && (
            <div className="mb-3">
              <div className="mb-1 text-xs font-medium text-muted-foreground">Notes</div>
              <p className="whitespace-pre-wrap text-sm">{estimate.notes}</p>
            </div>
          )}
          {estimate.terms && (
            <div>
              <div className="mb-1 text-xs font-medium text-muted-foreground">Terms</div>
              <p className="whitespace-pre-wrap text-sm">{estimate.terms}</p>
            </div>
          )}
        </Section>
      )}

      <DocumentVersionsSection documentType="estimate" documentId={estimate.id} />
    </RecordShell>
  );
}
