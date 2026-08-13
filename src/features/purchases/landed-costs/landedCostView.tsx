/**
 * landedCostView — the one description of a Landed Cost Voucher.
 *
 * The record page and the list peek are two projections of this descriptor,
 * so the charge ladder, allocation preview and accounting facts cannot drift
 * between surfaces.
 */
import { useMemo } from "react";
import { Link } from "react-router-dom";
import { format } from "date-fns";

import { Section } from "@/design-system";
import type {
  DocumentRecordView,
  DocumentTotalsRow,
  LineItemColumn,
  LineItemRow,
} from "@/design-system/records";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { useLandedCostRecord, type LandedCostRecord } from "./useLandedCosts";

function fmtDate(v: string | null | undefined) {
  if (!v) return "—";
  try {
    return format(new Date(v), "PP");
  } catch {
    return v;
  }
}

function humanize(v: string | null | undefined) {
  if (!v) return "—";
  return v.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

const CHARGE_COLUMNS: LineItemColumn[] = [
  { id: "type", header: "Charge", priority: 1, minWidth: 160 },
  { id: "basis", header: "Basis", priority: 3, minWidth: 90 },
  { id: "treatment", header: "Treatment", priority: 3, minWidth: 120, compactLabel: "Cap." },
  { id: "amount", header: "Amount", numeric: true, priority: 1, minWidth: 110 },
  { id: "base", header: "Base amount", numeric: true, priority: 2, minWidth: 120, compactLabel: "Base" },
];

interface Result {
  record: LandedCostRecord | null;
  loading: boolean;
  error: string | null;
  view: DocumentRecordView;
  refresh: () => void;
}

export function useLandedCostView(
  id: string | null | undefined,
  formatCurrency: (v: number) => string,
): Result {
  const { record, loading, error, refresh } = useLandedCostRecord(id);

  const view = useMemo<DocumentRecordView>(() => {
    const voucher = record?.voucher ?? null;
    const components = record?.components ?? [];
    const allocations = record?.allocations ?? [];
    const scope = record?.scope ?? [];

    const lineRows: LineItemRow[] = components.map((c) => ({
      id: c.id,
      cells: [
        {
          columnId: "type",
          content: c.component_type?.name ?? c.description ?? "Charge",
        },
        { columnId: "basis", content: humanize(c.basis) },
        {
          columnId: "treatment",
          content: c.is_capitalizable ? "Capitalised" : "Expensed",
        },
        { columnId: "amount", content: formatCurrency(Number(c.amount ?? 0)) },
        { columnId: "base", content: formatCurrency(Number(c.base_amount ?? 0)) },
      ],
    }));

    const totalsRows: DocumentTotalsRow[] = voucher
      ? [
          {
            label: "Total charges",
            value: formatCurrency(Number(voucher.total_amount ?? 0)),
          },
          {
            label: "Total (base currency)",
            value: formatCurrency(Number(voucher.total_base_amount ?? 0)),
          },
          {
            label: "Capitalised to inventory",
            value: formatCurrency(Number(voucher.capitalized_amount ?? 0)),
          },
          {
            label: "Expensed to COGS",
            value: formatCurrency(Number(voucher.expensed_amount ?? 0)),
            emphasized: true,
          },
        ]
      : [];

    // Allocation preview, rolled up per receipt line — the answer a buyer
    // actually wants: how much cost landed on each received item.
    const byLine = new Map<
      string,
      {
        label: string;
        receipt: string;
        allocated: number;
        capitalized: number;
        expensed: number;
      }
    >();
    for (const a of allocations) {
      const key = a.goods_receipt_item_id;
      const entry = byLine.get(key) ?? {
        label: a.product?.name ?? "Receipt line",
        receipt: a.goods_receipt?.receipt_number ?? "—",
        allocated: 0,
        capitalized: 0,
        expensed: 0,
      };
      entry.allocated += Number(a.allocated_amount ?? 0);
      entry.capitalized += Number(a.capitalized_amount ?? 0);
      entry.expensed += Number(a.expensed_amount ?? 0);
      byLine.set(key, entry);
    }
    const allocationRows = Array.from(byLine.values()).sort(
      (a, b) => b.allocated - a.allocated,
    );

    return {
      kind: "landed_cost_voucher",
      documentId: voucher?.id,
      eyebrow: "Landed Cost Voucher",
      listPath: "/purchases/landed-costs",
      title: voucher?.shipment_reference || voucher?.voucher_number || "Landed cost",
      docNumber: voucher?.voucher_number ?? undefined,
      status: voucher?.status,
      loading,
      error,
      notFound: !loading && !error && !voucher,
      meta: voucher ? (
        <>
          <span>Dated {fmtDate(voucher.voucher_date)}</span>
          {voucher.posting_date && <span>Posted {fmtDate(voucher.posting_date)}</span>}
          <span>
            {voucher.currency} @ {Number(voucher.exchange_rate ?? 1).toLocaleString()}
          </span>
        </>
      ) : undefined,
      detailsTitle: "Voucher details",
      detailFields: voucher
        ? [
            { label: "Voucher number", value: voucher.voucher_number ?? "—" },
            { label: "Shipment reference", value: voucher.shipment_reference ?? "—" },
            { label: "Voucher date", value: fmtDate(voucher.voucher_date) },
            { label: "Posting date", value: fmtDate(voucher.posting_date) },
            { label: "Default basis", value: humanize(voucher.default_basis) },
            { label: "Currency", value: voucher.currency },
            {
              label: "Exchange rate",
              value: `${Number(voucher.exchange_rate ?? 1)} (${fmtDate(voucher.exchange_rate_date)})`,
            },
            { label: "Goods receipts in scope", value: String(scope.length) },
            {
              label: "Journal entry",
              value: voucher.journal_entry_id ? (
                <Link
                  className="text-primary underline-offset-2 hover:underline"
                  to={`/finance/journal-entries/${voucher.journal_entry_id}`}
                >
                  View posting
                </Link>
              ) : (
                "Not posted"
              ),
            },
            ...(voucher.reversal_journal_entry_id
              ? [
                  {
                    label: "Reversal entry",
                    value: (
                      <Link
                        className="text-primary underline-offset-2 hover:underline"
                        to={`/finance/journal-entries/${voucher.reversal_journal_entry_id}`}
                      >
                        View reversal
                      </Link>
                    ),
                  },
                  { label: "Reversal reason", value: voucher.reversal_reason ?? "—" },
                ]
              : []),
            ...(voucher.notes ? [{ label: "Notes", value: voucher.notes }] : []),
          ]
        : [],
      lineColumns: CHARGE_COLUMNS,
      lineRows,
      lineEmpty: "No charges captured on this voucher yet.",
      totalsRows,
      extraSections: voucher ? (
        <>
          <Section title="Shipment scope" description="Goods receipts these charges land on">
            {scope.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No goods receipts in scope — allocation will be refused.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Receipt</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {scope.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell className="font-medium">
                        {s.goods_receipt?.receipt_number ?? s.goods_receipt_id}
                      </TableCell>
                      <TableCell>{fmtDate(s.goods_receipt?.receipt_date)}</TableCell>
                      <TableCell>
                        <Badge variant="secondary">
                          {humanize(s.goods_receipt?.status)}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Section>

          <Section
            title="Allocation"
            description="Charge landed on each received line, split between stock on hand and stock already sold"
          >
            {allocationRows.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Not allocated yet. Run “Allocate” to spread the charges across the
                receipt lines in scope.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Item</TableHead>
                    <TableHead>Receipt</TableHead>
                    <TableHead className="text-right">Allocated</TableHead>
                    <TableHead className="text-right">Capitalised</TableHead>
                    <TableHead className="text-right">Expensed</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {allocationRows.map((r, i) => (
                    <TableRow key={`${r.label}-${i}`}>
                      <TableCell className="font-medium">{r.label}</TableCell>
                      <TableCell>{r.receipt}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatCurrency(r.allocated)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatCurrency(r.capitalized)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatCurrency(r.expensed)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Section>
        </>
      ) : undefined,
    };
  }, [record, loading, error, formatCurrency]);

  return { record, loading, error, view, refresh };
}
