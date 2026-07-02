/**
 * Stage X2 — visual thermal-strip preview renderer.
 *
 * Pure component: takes a ReceiptDocumentModel + paper width and renders a
 * true-width simulated thermal receipt. NO data fetching, NO toasts, NO
 * print orchestration. The orchestrator (PostPaymentScreen /
 * ReceiptPreviewDialog) decides when/where to mount it.
 */
import { Separator } from "@/components/ui/separator";
import { format } from "date-fns";
import { QRCodeSVG } from "qrcode.react";
import { useCurrency } from "@/hooks/useCurrency";
import { formatReceiptAmount } from "@/lib/receiptConfig";
import { formatTransactionQty } from "@/lib/inventory/formatQty";
import type { ReceiptDocumentModel, ReceiptDocumentItem } from "../ReceiptDocumentModel";

function renderQtyCell(item: ReceiptDocumentItem, opts: { showBase?: boolean } = {}): string {
  const display = item.display_quantity != null && Number.isFinite(item.display_quantity)
    ? Number(item.display_quantity)
    : item.quantity;
  return formatTransactionQty(
    display,
    item.packaging_label ?? null,
    item.quantity,
    item.base_uom_label ?? "ea",
    { showBase: opts.showBase },
  );
}

export type ReceiptPaperWidth = "40mm" | "58mm" | "80mm";

interface PreviewRendererProps {
  model: ReceiptDocumentModel;
  paperWidth?: ReceiptPaperWidth;
  /** Render the strip at full thermal width (true) or shrink-to-fit a card (false, default). */
  trueWidth?: boolean;
  className?: string;
}

export function PreviewRenderer({
  model,
  paperWidth = "80mm",
  trueWidth = false,
  className,
}: PreviewRendererProps) {
  const { formatCurrency } = useCurrency();
  const { header, meta, items, totals, payments, footer_text, return_policy_text, flags, settings } = model;

  const widthStyle = trueWidth
    ? { width: paperWidth, maxWidth: "100%" }
    : undefined;

  return (
    <div
      data-testid="receipt-preview"
      style={widthStyle}
      className={`relative bg-white text-black dark:bg-muted/50 dark:text-foreground rounded-md p-3 sm:p-4 font-mono text-xs leading-snug space-y-2 mx-auto ${className ?? ""}`}
    >
      {/* Watermarks */}
      {flags.is_voided && (
        <Watermark label="VOID" tone="destructive" />
      )}
      {!flags.is_voided && flags.is_refund && (
        <Watermark label="REFUND" tone="warning" />
      )}
      {!flags.is_voided && !flags.is_refund && flags.is_reprint && (
        <Watermark label="REPRINT" tone="muted" />
      )}

      {/* Header */}
      <div className="text-center">
        {settings.show_logo && header.logo_url && (
          <img
            src={header.logo_url}
            alt={header.business_name}
            className="h-10 mx-auto mb-2 object-contain"
          />
        )}
        <h3 className="font-bold text-sm truncate">{header.business_name}</h3>
        {header.address && <p className="text-[10px]">{header.address}</p>}
        {header.city && <p className="text-[10px]">{header.city}</p>}
        {header.phone && <p className="text-[10px]">Tel: {header.phone}</p>}
        {header.tax_id && <p className="text-[10px]">PIN: {header.tax_id}</p>}
        {header.header_text && (
          <p className="text-[10px] whitespace-pre-line mt-1">{header.header_text}</p>
        )}
      </div>

      <Separator />

      {/* Title — single source of truth shared with ESC/POS bytes */}
      <div className="text-center font-bold text-sm tracking-wide">
        {meta.title}
      </div>

      {/* Meta */}
      <div className="text-[10px] space-y-0.5">
        {settings.show_receipt_number && (
          <p className="truncate text-center">#{meta.transaction_number}</p>
        )}
        {settings.show_date_time && (
          <p>Date: {format(new Date(meta.created_at), "MMM d, yyyy h:mm a")}</p>
        )}
        {settings.show_customer_name && meta.customer_name && (
          <p className="truncate">Customer: {meta.customer_name}</p>
        )}
        {settings.show_cashier_name && meta.cashier_name && (
          <p className="truncate">
            {settings.cashier_label_format === "served_by" ? "You were served by: " : "Cashier: "}
            {meta.cashier_name}
          </p>
        )}
      </div>

      <Separator />

      {/* Items */}
      <div className="space-y-1">
        {settings.item_display_format === "tabular" && (
          <div className="flex justify-between text-[9px] font-bold border-b pb-1 mb-1">
            <span className="flex-1 min-w-0">ITEM</span>
            {settings.show_item_quantity && <span className="w-10 text-center">QTY</span>}
            {settings.show_unit_price && <span className="w-14 text-right">PRICE</span>}
            <span className="w-16 text-right">AMOUNT</span>
          </div>
        )}
        {items.map((item, i) => (
          <div key={i} className="text-[10px]">
            {settings.item_display_format === "tabular" ? (
              <>
                <div className="font-medium">{item.product_name}</div>
                <div className="flex justify-between gap-1 text-muted-foreground mt-0.5">
                  <span className="flex-1 min-w-0 truncate">
                    {settings.show_item_sku && item.sku ? item.sku : ""}
                  </span>
                  {settings.show_item_quantity && (
                    <span className="w-16 text-center whitespace-nowrap">{renderQtyCell(item, { showBase: false })}</span>
                  )}
                  {settings.show_unit_price && (
                    <span className="w-14 text-right whitespace-nowrap">
                      {formatReceiptAmount(item.unit_price)}
                    </span>
                  )}
                  <span className="w-16 text-right font-medium text-foreground whitespace-nowrap">
                    {formatReceiptAmount(item.line_total)}
                  </span>
                </div>
              </>
            ) : (
              <div className="flex justify-between gap-2">
                <span className="flex-1 truncate">
                  {settings.show_item_quantity && `${renderQtyCell(item, { showBase: false })} `}
                  {item.product_name}
                </span>
                <span className="shrink-0 whitespace-nowrap">
                  {formatReceiptAmount(item.line_total)}
                </span>
              </div>
            )}
          </div>
        ))}
      </div>

      <Separator />

      {/* Totals */}
      <div className="space-y-0.5 text-[10px]">
        {settings.show_subtotal && (
          <Row label="Subtotal" value={formatCurrency(totals.subtotal)} />
        )}
        {settings.show_discount_total && totals.discount_amount > 0 && (
          <Row
            label={settings.show_savings ? "You Saved" : "Discount"}
            value={`-${formatCurrency(totals.discount_amount)}`}
            className="text-green-600"
          />
        )}
        {settings.show_tax_breakdown && (
          <Row label="Tax" value={formatCurrency(totals.tax_amount)} />
        )}
        <div className="flex justify-between font-bold text-sm pt-1.5 border-t">
          <span>TOTAL</span>
          <span className="whitespace-nowrap">{formatCurrency(totals.total_amount)}</span>
        </div>
      </div>

      {/* Payments + change */}
      {settings.show_payment_method && payments.length > 0 && (
        <>
          <Separator />
          <div className="text-[10px] space-y-0.5">
            <p className="font-semibold mb-0.5">Payment</p>
            {payments.map((p, i) => {
              const isMpesa =
                p.payment_method?.toLowerCase().includes("mpesa") ||
                p.payment_method === "mobile_money";
              return (
                <div key={i}>
                  <Row
                    label={isMpesa ? "M-Pesa" : p.payment_method}
                    value={formatCurrency(p.amount)}
                    capitalize
                  />
                  {isMpesa && p.reference && (
                    <p className="text-[9px] text-muted-foreground text-center">
                      Ref: {p.reference}
                    </p>
                  )}
                </div>
              );
            })}
            {totals.change_due > 0 && (
              <div className="flex justify-between font-bold pt-1 border-t">
                <span>Change</span>
                <span className="whitespace-nowrap">{formatCurrency(totals.change_due)}</span>
              </div>
            )}
          </div>
        </>
      )}

      {/* eTIMS */}
      {settings.show_etims_qr && meta.etims_qr_data && (
        <>
          <Separator />
          <div className="text-center space-y-1">
            <p className="text-[10px] font-semibold">KRA eTIMS</p>
            <div className="flex justify-center">
              <QRCodeSVG value={meta.etims_qr_data} size={80} level="M" />
            </div>
            {settings.show_etims_info && meta.etims_cu_number && (
              <p className="text-[10px] text-muted-foreground">CU: {meta.etims_cu_number}</p>
            )}
          </div>
        </>
      )}

      {/* Footer */}
      {footer_text && (
        <div className="text-center text-[10px] text-muted-foreground pt-1.5 whitespace-pre-line">
          <p>{footer_text}</p>
        </div>
      )}
      {return_policy_text && (
        <div className="text-center text-[9px] text-muted-foreground border-t pt-2 mt-2">
          <p>{return_policy_text}</p>
        </div>
      )}
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
    <div className={`flex justify-between ${className}`}>
      <span className={capitalize ? "capitalize truncate" : "truncate"}>{label}</span>
      <span className="whitespace-nowrap">{value}</span>
    </div>
  );
}

function Watermark({
  label,
  tone,
}: {
  label: string;
  tone: "destructive" | "warning" | "muted";
}) {
  const colorClass =
    tone === "destructive"
      ? "text-destructive/30 border-destructive/30"
      : tone === "warning"
      ? "text-amber-500/40 border-amber-500/40"
      : "text-muted-foreground/30 border-muted-foreground/30";
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 flex items-center justify-center select-none z-10"
    >
      <span
        className={`font-extrabold tracking-widest text-5xl rotate-[-25deg] border-4 px-6 py-2 rounded ${colorClass}`}
      >
        {label}
      </span>
    </div>
  );
}