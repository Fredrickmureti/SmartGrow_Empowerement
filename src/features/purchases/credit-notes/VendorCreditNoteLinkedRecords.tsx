/**
 * VendorCreditNoteLinkedRecords — the lineage chain of a vendor credit note.
 *
 * ADR 0132: a credit is only auditable if the operator can walk back to the
 * documents it came from — the supplier bill it offsets, the purchase order
 * and goods receipt it disputes, the purchase return that produced it — and
 * forward to the journal entry it posted. This panel is that walk.
 */
import { Link } from "react-router-dom";
import { ExternalLink } from "lucide-react";

import { Section } from "@/design-system";
import type { VendorCreditNote } from "@/hooks/useVendorCreditNotes";

interface LinkedRow {
  label: string;
  value: string;
  to?: string;
}

interface Props {
  creditNote: VendorCreditNote;
}

export function VendorCreditNoteLinkedRecords({ creditNote }: Props) {
  const cn = creditNote as any;

  const rows: LinkedRow[] = [];

  if (cn.bill_id) {
    rows.push({
      label: "Supplier bill",
      value: cn.bill?.bill_number ?? "Bill",
      to: `/purchases/bills/${cn.bill_id}`,
    });
  }
  if (cn.purchase_order_id) {
    rows.push({
      label: "Purchase order",
      value: cn.purchase_order?.po_number ?? "Purchase order",
      to: `/purchases/orders/${cn.purchase_order_id}`,
    });
  }
  if (cn.goods_receipt_id) {
    // There is no standalone GRN record route today — show the receipt number
    // rather than a link that would dead-end the operator.
    rows.push({
      label: "Goods receipt",
      value: cn.goods_receipt?.receipt_number ?? "Goods receipt",
    });
  }

  if (cn.source_return_id) {
    rows.push({
      label: "Purchase return",
      value: cn.source_return?.return_number ?? "Purchase return",
      to: `/purchases/returns/${cn.source_return_id}`,
    });
  }
  if (cn.journal_entry_id) {
    rows.push({
      label: "Journal entry",
      value: "Posted entry",
      to: `/finance/journal-entries/${cn.journal_entry_id}`,
    });
  }
  if (cn.reversal_journal_entry_id) {
    rows.push({
      label: "Reversal entry",
      value: "Reversal entry",
      to: `/finance/journal-entries/${cn.reversal_journal_entry_id}`,
    });
  }

  return (
    <Section title="Linked records">
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          This credit note stands alone — no upstream document was attached to it.
        </p>
      ) : (
        <dl className="divide-y divide-border text-sm">
          {rows.map((row) => (
            <div
              key={`${row.label}-${row.value}`}
              className="flex items-center justify-between gap-4 py-2"
            >
              <dt className="text-muted-foreground">{row.label}</dt>
              <dd className="font-medium">
                {row.to ? (
                  <Link
                    to={row.to}
                    className="inline-flex items-center gap-1 underline underline-offset-2"
                  >
                    {row.value}
                    <ExternalLink className="h-3 w-3" aria-hidden />
                  </Link>
                ) : (
                  row.value
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </Section>
  );
}
