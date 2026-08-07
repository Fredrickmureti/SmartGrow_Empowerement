import {
  AlertTriangle,
  Boxes,
  Info,
  Landmark,
  Loader2,
  ReceiptText,
  Wallet,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useCurrency } from "@/hooks/useCurrency";
import type {
  ReversalConsequences,
  ReversalMoneyInvoiceLine,
  ReversalMoneyPaymentLine,
  ReversalWarningSeverity,
} from "@/hooks/useTransactionReversal";

/**
 * Phase 2 — consequence preview.
 *
 * Renders `preview_reversal_consequences` so no reversal is ever authorised
 * blind: which accounts move, what returns to stock, whose money changes, what
 * has already been derived from the document, and what the business should know
 * before continuing.
 *
 * PURELY PRESENTATIONAL. It must not query Supabase or derive accounting,
 * inventory or settlement figures itself — the server walks the same predicates
 * the void writers walk, and a second derivation here would drift from what
 * actually posts. Fetching lives in `useReversalConsequences`.
 * Pinned by `src/test/architecture/reversal-consequence-preview.test.ts`.
 */
interface ReversalConsequencePreviewProps {
  consequences: ReversalConsequences | null;
  isLoading: boolean;
  isError: boolean;
  /** Currency of the document being reversed, for display only. */
  currency?: string;
}

const SEVERITY_ORDER: Record<ReversalWarningSeverity, number> = {
  error: 0,
  warning: 1,
  info: 2,
};

const SUBTYPE_LABELS: Record<string, string> = {
  main: "Main entry",
  cogs: "Cost of goods sold",
};

function isInvoiceMoneyLine(
  line: ReversalMoneyPaymentLine | ReversalMoneyInvoiceLine,
): line is ReversalMoneyInvoiceLine {
  return "invoice_id" in line;
}

function SectionHeading({
  icon: Icon,
  title,
  hint,
}: {
  icon: typeof Landmark;
  title: string;
  hint?: string;
}) {
  return (
    <div className="flex items-start gap-2">
      <Icon className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
      <div>
        <p className="text-sm font-medium leading-none">{title}</p>
        {hint && <p className="text-xs text-muted-foreground mt-1">{hint}</p>}
      </div>
    </div>
  );
}

export function ReversalConsequencePreview({
  consequences,
  isLoading,
  isError,
  currency,
}: ReversalConsequencePreviewProps) {
  const { formatCurrency } = useCurrency();

  if (isLoading) {
    return (
      <div className="rounded-lg border p-4 space-y-3">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Working out what this would change…
        </div>
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  if (isError || !consequences) {
    return (
      <Alert variant="destructive">
        <AlertTriangle className="h-4 w-4" />
        <AlertDescription>
          We could not work out what this reversal would change, so it is not safe to
          continue. Close this panel and try again.
        </AlertDescription>
      </Alert>
    );
  }

  const { gl, stock, money, related_documents, warnings, document_type } = consequences;
  const sortedWarnings = [...warnings].sort(
    (a, b) => (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3),
  );
  const derived = related_documents.filter((doc) => doc.count > 0);

  return (
    <div className="rounded-lg border divide-y">
      {/* ------------------------------------------------------- accounting */}
      <div className="p-4 space-y-3">
        <SectionHeading
          icon={Landmark}
          title="Accounting"
          hint={
            gl.entry_count > 0
              ? "These postings will be mirrored with the opposite sign. The original entries stay on record."
              : undefined
          }
        />
        {gl.entry_count === 0 ? (
          <p className="text-sm text-muted-foreground">
            No live accounting entry is attached, so nothing will be posted to the
            ledger.
          </p>
        ) : (
          <div className="space-y-3">
            {gl.entries.map((entry) => (
              <div key={entry.journal_entry_id} className="space-y-1">
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="text-[10px]">
                    {SUBTYPE_LABELS[entry.subtype] ?? entry.subtype}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {entry.entry_number ?? "—"}
                    {entry.entry_date ? ` · ${entry.entry_date}` : ""}
                  </span>
                </div>
                <div className="space-y-1">
                  {entry.lines.map((line, index) => (
                    <div
                      key={`${entry.journal_entry_id}-${line.account_id ?? index}`}
                      className="flex items-center justify-between gap-3 text-sm"
                    >
                      <span className="truncate">
                        {line.account_code ? `${line.account_code} · ` : ""}
                        {line.account_name ?? "Unmapped account"}
                      </span>
                      <span className="shrink-0 tabular-nums text-muted-foreground">
                        {line.reverse_debit > 0
                          ? `Dr ${formatCurrency(line.reverse_debit, currency)}`
                          : `Cr ${formatCurrency(line.reverse_credit, currency)}`}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
            <div className="flex items-center justify-between text-sm font-medium pt-1">
              <span>Total reversed</span>
              <span className="tabular-nums">
                {formatCurrency(gl.total_reversed, currency)}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* -------------------------------------------------------- inventory */}
      {document_type === "invoice" && (
        <div className="p-4 space-y-3">
          <SectionHeading
            icon={Boxes}
            title="Inventory"
            hint={
              stock.line_count > 0
                ? "These quantities return to stock as a receipt. Existing movements are not deleted."
                : undefined
            }
          />
          {stock.line_count === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing returns to stock — no tracked goods movement is attached to this
              document, or stock was already returned.
            </p>
          ) : (
            <div className="space-y-1">
              {stock.lines.map((line) => (
                <div
                  key={`${line.product_id}-${line.warehouse_id ?? "none"}`}
                  className="flex items-center justify-between gap-3 text-sm"
                >
                  <span className="truncate">
                    {line.product_name ?? "Product"}
                    {line.product_sku ? ` · ${line.product_sku}` : ""}
                    {line.warehouse_name ? ` → ${line.warehouse_name}` : ""}
                  </span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    +{line.quantity}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ------------------------------------------------------------ money */}
      <div className="p-4 space-y-3">
        <SectionHeading
          icon={Wallet}
          title="Money"
          hint={
            document_type === "invoice"
              ? "Customer payments are never unwound by this reversal. Reverse them separately if that is the intent."
              : "The invoices this payment settles return to these balances."
          }
        />
        {money.line_count === 0 ? (
          <p className="text-sm text-muted-foreground">
            {document_type === "invoice"
              ? "No customer payment is attached, so no cash is affected."
              : "This payment is not applied to any invoice, so no invoice balance changes."}
          </p>
        ) : (
          <div className="space-y-1">
            {money.lines.map((line) =>
              isInvoiceMoneyLine(line) ? (
                <div
                  key={line.invoice_id}
                  className="flex items-center justify-between gap-3 text-sm"
                >
                  <span className="truncate">{line.invoice_number ?? "Invoice"}</span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {formatCurrency(line.amount_paid_now, currency)} →{" "}
                    {formatCurrency(line.amount_paid_after, currency)}
                  </span>
                </div>
              ) : (
                <div
                  key={line.payment_id}
                  className="flex items-center justify-between gap-3 text-sm"
                >
                  <span className="truncate flex items-center gap-2">
                    {line.receipt_number ?? "Payment"}
                    {line.bank_reconciled && (
                      <Badge variant="outline" className="text-[10px]">
                        Bank reconciled
                      </Badge>
                    )}
                  </span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {formatCurrency(line.allocated_amount, currency)}
                  </span>
                </div>
              ),
            )}
          </div>
        )}
      </div>

      {/* --------------------------------------- derived documents & warnings */}
      {(derived.length > 0 || sortedWarnings.length > 0) && (
        <div className="p-4 space-y-3">
          <SectionHeading icon={ReceiptText} title="Consequences" />
          {derived.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {derived.map((doc) => (
                <Badge key={doc.kind} variant="secondary" className="text-[10px]">
                  {doc.label}: {doc.count}
                </Badge>
              ))}
            </div>
          )}
          {sortedWarnings.map((warning) => (
            <Alert
              key={warning.code}
              variant={warning.severity === "error" ? "destructive" : "default"}
            >
              {warning.severity === "info" ? (
                <Info className="h-4 w-4" />
              ) : (
                <AlertTriangle className="h-4 w-4" />
              )}
              <AlertDescription className="text-xs">{warning.message}</AlertDescription>
            </Alert>
          ))}
        </div>
      )}
    </div>
  );
}
