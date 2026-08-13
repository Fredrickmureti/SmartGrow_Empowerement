/**
 * journalEntryView — shared view spec for a JournalEntry, consumed by
 * both the peek sheet (`PeekScaffold`) and the full record page
 * (`RecordScaffold`). Keeps peek/full parity guaranteed.
 */
import type { ReactNode } from "react";
import { format } from "date-fns";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/design-system";
import type {
  DetailField,
  DocumentActivityEntry,
  DocumentTotalsRow,
  LineItemColumn,
  LineItemRow,
} from "@/design-system";
import type { JournalEntry } from "@/hooks/useJournalEntries";
import type { JournalSourceDocument } from "./useJournalSourceDocument";

export function journalEntryStatusBadge(entry: JournalEntry): ReactNode {
  const s = entry.status;
  if (s === "draft") return <StatusBadge tone="neutral">Draft</StatusBadge>;
  if (s === "posted") {
    if (entry.is_reversal) return <StatusBadge tone="accent">Reversal</StatusBadge>;
    return <StatusBadge tone="success">Posted</StatusBadge>;
  }
  if (s === "reversed") return <StatusBadge tone="warning">Reversed</StatusBadge>;
  if (s === "voided") return <StatusBadge tone="danger">Voided</StatusBadge>;
  return <StatusBadge>{s}</StatusBadge>;
}

interface BuildOpts {
  formatCurrency: (n: number) => string;
  /** Look up related entries by id (for reversal chip labels). */
  findEntry?: (id: string) => JournalEntry | undefined;
  /** Originating business document, resolved by `useJournalSourceDocument`. */
  sourceDocument?: JournalSourceDocument | null;
}

export interface JournalEntryView {
  title: string;
  docNumber: string;
  status: ReactNode;
  meta: ReactNode;
  detailFields: DetailField[];
  lineColumns: LineItemColumn[];
  lineRows: LineItemRow[];
  totalsRows: DocumentTotalsRow[];
  activity: DocumentActivityEntry[];
}

function fmtDateTime(iso: string | null): string | null {
  if (!iso) return null;
  try {
    return format(new Date(iso), "MMM d, yyyy HH:mm");
  } catch {
    return iso;
  }
}

export function buildJournalEntryView(
  entry: JournalEntry,
  { formatCurrency, findEntry }: BuildOpts,
): JournalEntryView {
  const title = entry.description || `Journal Entry ${entry.entry_number}`;
  const docNumber = entry.entry_number;

  const meta = (
    <>
      <span>{format(new Date(entry.entry_date), "MMMM d, yyyy")}</span>
      {entry.reference && <span>Ref: {entry.reference}</span>}
      {entry.is_adjusting && <Badge variant="outline">Adjusting</Badge>}
      {entry.is_reversal && entry.reversal_of_id && (
        <Badge variant="outline" className="text-purple-700">
          Reversal of {findEntry?.(entry.reversal_of_id)?.entry_number ?? "—"}
        </Badge>
      )}
      {entry.reversed_by_id && (
        <Badge variant="outline" className="text-amber-700">
          Reversed by {findEntry?.(entry.reversed_by_id)?.entry_number ?? "—"}
        </Badge>
      )}
    </>
  );

  const detailFields: DetailField[] = [
    { label: "Entry #", value: entry.entry_number },
    { label: "Date", value: format(new Date(entry.entry_date), "MMMM d, yyyy") },
    { label: "Description", value: entry.description || "—" },
    { label: "Reference", value: entry.reference || "—" },
    { label: "Source", value: entry.source_type ? entry.source_type.replace(/_/g, " ") : "Manual" },
    { label: "Status", value: journalEntryStatusBadge(entry) },
  ];
  if (entry.void_reason) {
    detailFields.push({ label: "Void reason", value: entry.void_reason });
  }

  const lineColumns: LineItemColumn[] = [
    { id: "account", header: "Account" },
    { id: "description", header: "Description" },
    { id: "debit", header: "Debit", numeric: true, width: "140px" },
    { id: "credit", header: "Credit", numeric: true, width: "140px" },
  ];

  const lineRows: LineItemRow[] = (entry.lines ?? []).map((l) => ({
    id: l.id,
    cells: [
      {
        columnId: "account",
        content: l.accounts ? `${l.accounts.code} · ${l.accounts.name}` : "—",
      },
      { columnId: "description", content: l.description || "—" },
      {
        columnId: "debit",
        content: l.debit > 0 ? formatCurrency(l.debit) : "—",
      },
      {
        columnId: "credit",
        content: l.credit > 0 ? formatCurrency(l.credit) : "—",
      },
    ],
  }));

  const totalDebit = entry.total_debit ?? 0;
  const totalCredit = entry.total_credit ?? 0;
  const balanced = Math.abs(totalDebit - totalCredit) < 0.005;

  const totalsRows: DocumentTotalsRow[] = [
    { label: "Total debit", value: formatCurrency(totalDebit) },
    { label: "Total credit", value: formatCurrency(totalCredit) },
    {
      label: balanced ? "Balanced" : "Out of balance",
      value: balanced ? "✓" : formatCurrency(totalDebit - totalCredit),
      emphasized: true,
    },
  ];

  const activity: DocumentActivityEntry[] = [];
  if (entry.created_at) {
    activity.push({
      id: "created",
      at: fmtDateTime(entry.created_at) ?? entry.created_at,
      title: "Created",
      tone: "neutral",
    });
  }
  if (entry.posted_at) {
    activity.push({
      id: "posted",
      at: fmtDateTime(entry.posted_at) ?? entry.posted_at,
      title: "Posted",
      tone: "success",
    });
  }
  if (entry.voided_at) {
    activity.push({
      id: "voided",
      at: fmtDateTime(entry.voided_at) ?? entry.voided_at,
      title: "Voided",
      description: entry.void_reason ?? undefined,
      tone: "danger",
    });
  }

  return {
    title,
    docNumber,
    status: journalEntryStatusBadge(entry),
    meta,
    detailFields,
    lineColumns,
    lineRows,
    totalsRows,
    activity,
  };
}