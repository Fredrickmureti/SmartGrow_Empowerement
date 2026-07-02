/**
 * TransactionSummaryView — screen-optimized POS receipt presentation.
 *
 * Decoupled from thermal-strip / ESC/POS simulation. Consumes the same
 * `ReceiptDocumentModel` that feeds the printer pipeline so the displayed
 * data is byte-aligned with what gets printed, but the layout is built
 * for a screen: responsive cards, a real <Table> for line items, design
 * tokens (no `bg-white`/`text-black`), and full-size eTIMS QR.
 *
 * Renderers in `src/lib/pos/receipt/renderers/` remain untouched — they
 * stay the source of truth for paper output and the WYSIWYG print preview.
 */
import { format } from "date-fns";
import { QRCodeSVG } from "qrcode.react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useCurrency } from "@/hooks/useCurrency";
import type { ReceiptDocumentModel } from "@/lib/pos/receipt/ReceiptDocumentModel";

interface TransactionSummaryViewProps {
  model: ReceiptDocumentModel;
  className?: string;
}

export function TransactionSummaryView({ model, className }: TransactionSummaryViewProps) {
  const { formatCurrency } = useCurrency();
  const { header, meta, items, totals, payments, footer_text, return_policy_text, flags, settings } = model;

  return (
    <div data-testid="transaction-summary-view" className={`space-y-4 ${className ?? ""}`}>
      {/* Header card */}
      <Card className="p-4 sm:p-5">
        <div className="flex items-start gap-3">
          {settings.show_logo && header.logo_url && (
            <img
              src={header.logo_url}
              alt={header.business_name}
              className="h-12 w-12 rounded object-contain border bg-background shrink-0"
            />
          )}
          <div className="min-w-0 flex-1">
            <h3 className="text-base sm:text-lg font-semibold truncate">{header.business_name}</h3>
            <div className="mt-0.5 text-xs text-muted-foreground space-y-0.5">
              {(header.address || header.city) && (
                <p className="truncate">
                  {[header.address, header.city].filter(Boolean).join(", ")}
                </p>
              )}
              {header.phone && <p className="truncate">Tel: {header.phone}</p>}
              {header.tax_id && <p className="truncate">PIN: {header.tax_id}</p>}
            </div>
          </div>
          <div className="flex flex-wrap gap-1 justify-end shrink-0">
            {flags.is_voided && <Badge variant="destructive">VOID</Badge>}
            {!flags.is_voided && flags.is_refund && (
              <Badge className="bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30">REFUND</Badge>
            )}
            {!flags.is_voided && !flags.is_refund && flags.is_reprint && (
              <Badge variant="secondary">REPRINT</Badge>
            )}
            {flags.is_offline && <Badge variant="outline">OFFLINE</Badge>}
          </div>
        </div>

        <Separator className="my-3" />

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
          <Field label="Title" value={meta.title} />
          <Field label="Receipt #" value={meta.transaction_number} />
          <Field
            label="Date"
            value={format(new Date(meta.created_at), "MMM d, yyyy h:mm a")}
          />
          {settings.show_cashier_name && meta.cashier_name && (
            <Field label="Cashier" value={meta.cashier_name} />
          )}
          {settings.show_customer_name && meta.customer_name && (
            <Field label="Customer" value={meta.customer_name} />
          )}
        </div>
      </Card>

      {/* Items table */}
      <Card className="overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Item</TableHead>
              {settings.show_item_quantity && (
                <TableHead className="text-center w-16">Qty</TableHead>
              )}
              {settings.show_unit_price && (
                <TableHead className="text-right w-24">Unit</TableHead>
              )}
              <TableHead className="text-right w-28">Amount</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((it, i) => (
              <TableRow key={i}>
                <TableCell>
                  <div className="font-medium">{it.product_name}</div>
                  {settings.show_item_sku && it.sku && (
                    <div className="text-[11px] text-muted-foreground">{it.sku}</div>
                  )}
                </TableCell>
                {settings.show_item_quantity && (
                  <TableCell className="text-center tabular-nums">{it.quantity}</TableCell>
                )}
                {settings.show_unit_price && (
                  <TableCell className="text-right tabular-nums">
                    {formatCurrency(it.unit_price)}
                  </TableCell>
                )}
                <TableCell className="text-right tabular-nums font-medium">
                  {formatCurrency(it.line_total)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      {/* Totals + Payments */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Card className="p-4 space-y-1.5 text-sm">
          {settings.show_subtotal && (
            <Row label="Subtotal" value={formatCurrency(totals.subtotal)} />
          )}
          {settings.show_discount_total && totals.discount_amount > 0 && (
            <Row
              label={settings.show_savings ? "You Saved" : "Discount"}
              value={`-${formatCurrency(totals.discount_amount)}`}
              className="text-emerald-600 dark:text-emerald-400"
            />
          )}
          {settings.show_tax_breakdown && (
            <Row label="Tax" value={formatCurrency(totals.tax_amount)} />
          )}
          <Separator className="my-2" />
          <div className="flex justify-between items-baseline">
            <span className="text-sm font-semibold">Total</span>
            <span className="text-xl font-bold tabular-nums">
              {formatCurrency(totals.total_amount)}
            </span>
          </div>
        </Card>

        <Card className="p-4 space-y-2 text-sm">
          <div className="text-xs uppercase tracking-wide text-muted-foreground font-medium">
            Payment
          </div>
          {payments.length === 0 && (
            <p className="text-muted-foreground text-xs">No payments recorded.</p>
          )}
          {settings.show_payment_method && payments.map((p, i) => {
            const isMpesa =
              p.payment_method?.toLowerCase().includes("mpesa") ||
              p.payment_method === "mobile_money";
            return (
              <div key={i} className="space-y-0.5">
                <Row
                  label={isMpesa ? "M-Pesa" : p.payment_method}
                  value={formatCurrency(p.amount)}
                  capitalize
                />
                {isMpesa && p.reference && (
                  <p className="text-[11px] text-muted-foreground">Ref: {p.reference}</p>
                )}
              </div>
            );
          })}
          <Separator className="my-2" />
          <Row label="Tendered" value={formatCurrency(totals.amount_tendered)} />
          {totals.change_due > 0 && (
            <div className="flex justify-between items-baseline pt-1">
              <span className="text-sm font-semibold">Change due</span>
              <span className="text-lg font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
                {formatCurrency(totals.change_due)}
              </span>
            </div>
          )}
        </Card>
      </div>

      {/* eTIMS */}
      {settings.show_etims_qr && meta.etims_qr_data && (
        <Card className="p-4 flex flex-col sm:flex-row items-center gap-4">
          <div className="bg-background p-2 rounded border">
            <QRCodeSVG value={meta.etims_qr_data} size={140} level="M" />
          </div>
          <div className="text-sm space-y-1 text-center sm:text-left">
            <p className="font-semibold">KRA eTIMS</p>
            {settings.show_etims_info && meta.etims_cu_number && (
              <p className="text-xs text-muted-foreground">
                Control Unit: <span className="tabular-nums">{meta.etims_cu_number}</span>
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Scan to verify this receipt with the Kenya Revenue Authority.
            </p>
          </div>
        </Card>
      )}

      {/* Footer / return policy */}
      {(footer_text || return_policy_text) && (
        <Card className="p-4 text-xs text-muted-foreground space-y-2 text-center">
          {footer_text && <p className="whitespace-pre-line">{footer_text}</p>}
          {return_policy_text && (
            <p className="whitespace-pre-line border-t pt-2">{return_policy_text}</p>
          )}
        </Card>
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="truncate">{value}</div>
    </div>
  );
}

function Row({
  label,
  value,
  className = "",
  capitalize = false,
}: {
  label: string;
  value: string;
  className?: string;
  capitalize?: boolean;
}) {
  return (
    <div className={`flex justify-between gap-2 ${className}`}>
      <span className={`text-muted-foreground ${capitalize ? "capitalize" : ""}`}>{label}</span>
      <span className="tabular-nums font-medium">{value}</span>
    </div>
  );
}
