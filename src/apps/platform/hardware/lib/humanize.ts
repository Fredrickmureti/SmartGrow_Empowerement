/**
 * humanize.ts — canonical presentation contract for the Hardware
 * Operations Workspace (ADR-0100).
 *
 * Turns internal enum strings (`doc_type`, `intent`, `format`, `transport`,
 * `status`, `RuntimeReason`) into short, business-oriented labels that
 * operators can understand without decoding a schema.
 *
 * These are pure functions — no I/O, no React, cheap to import from tests
 * and architecture guards.
 */

export function docTypeLabel(docType: string | null | undefined): string {
  if (!docType) return "Document";
  const map: Record<string, string> = {
    invoice: "Invoice",
    receipt: "Receipt",
    pos_receipt: "POS receipt",
    pos_transaction: "POS receipt",
    credit_note: "Credit note",
    vendor_credit_note: "Vendor credit note",
    delivery_note: "Delivery note",
    goods_receipt: "Goods receipt",
    purchase_order: "Purchase order",
    sales_order: "Sales order",
    estimate: "Estimate",
    quote: "Quote",
    proforma_invoice: "Proforma invoice",
    bill: "Bill",
    payslip: "Payslip",
    payroll_bank_file: "Payroll bank file",
    payment_receipt: "Payment receipt",
    customer_statement: "Customer statement",
    vendor_statement: "Vendor statement",
    legal_recipient_statement: "Statement to legal recipient",
    tax_certificate: "Tax certificate",
    stock_transfer: "Stock transfer",
    stock_adjustment: "Stock adjustment",
    shelf_edge: "Shelf-edge label",
    product_label: "Product label",
    barcode_label: "Barcode label",
    lot_label: "Lot label",
    packing_slip: "Packing slip",
  };
  return map[docType] ?? prettifyEnum(docType);
}

export function intentLabel(intent: string | null | undefined): string {
  if (!intent) return "—";
  const map: Record<string, string> = {
    customer_copy: "Customer copy",
    merchant_copy: "Merchant copy",
    kitchen_copy: "Kitchen copy",
    bar_copy: "Bar copy",
    duplicate: "Duplicate",
    reprint: "Reprint",
    original: "Original",
    shelf_edge: "Shelf-edge",
    label: "Label",
    a4_print: "A4 document",
    thermal_receipt: "Thermal receipt",
  };
  return map[intent] ?? prettifyEnum(intent);
}

export function formatLabel(format: string | null | undefined): string {
  if (!format) return "—";
  const map: Record<string, string> = {
    pdf: "PDF",
    "pdf-browser": "PDF (browser)",
    pdf_a4: "PDF A4",
    escpos: "ESC/POS",
    escpos_label: "ESC/POS label",
    zpl: "ZPL",
    zpl_label: "ZPL label",
    epl: "EPL",
    epl_label: "EPL label",
    html: "HTML",
    png: "PNG",
    raw: "Raw bytes",
  };
  return map[format] ?? prettifyEnum(format);
}

export function transportLabel(transport: string | null | undefined): string {
  if (!transport) return "Unknown transport";
  const map: Record<string, string> = {
    "pdf-browser": "Browser print dialog",
    browser: "Browser print dialog",
    "os-print": "OS print dialog",
    usb: "USB",
    "usb-electron": "USB (desktop app)",
    webusb: "USB (browser)",
    serial: "Serial",
    webserial: "Serial (browser)",
    hid: "HID",
    webhid: "HID (browser)",
    network: "Network",
    "network-9100": "Network (raw 9100)",
    lan: "Network",
    cups: "CUPS",
    agent: "IoT agent",
    "iot-agent": "IoT agent",
    bluetooth: "Bluetooth",
  };
  return map[transport] ?? prettifyEnum(transport);
}

export type PrintStatusKey =
  | "queued"
  | "sent"
  | "acked"
  | "printed"
  | "failed"
  | "cancelled"
  | "canceled";

export function statusLabel(status: string | null | undefined): string {
  if (!status) return "—";
  const map: Record<string, string> = {
    queued: "Queued",
    sent: "Sent to printer",
    acked: "Printed",
    printed: "Printed",
    failed: "Failed",
    cancelled: "Cancelled",
    canceled: "Cancelled",
  };
  return map[status] ?? prettifyEnum(status);
}

export function statusTone(
  status: string | null | undefined,
): "default" | "secondary" | "outline" | "destructive" {
  switch (status) {
    case "acked":
    case "printed":
      return "default";
    case "sent":
      return "secondary";
    case "failed":
      return "destructive";
    case "cancelled":
    case "canceled":
      return "outline";
    default:
      return "outline";
  }
}

export function runtimeReasonLabel(reason: string | null | undefined): string {
  if (!reason) return "—";
  const map: Record<string, string> = {
    "electron-bypass": "Desktop app (direct)",
    "browser-direct": "Browser or IoT agent",
    "electron-fallback-unexpected": "Desktop app fell back to browser (needs update)",
  };
  return map[reason] ?? prettifyEnum(reason);
}

export type ErrorCategory =
  | "offline"
  | "out-of-paper"
  | "driver-missing"
  | "permission"
  | "timeout"
  | "unknown";

export function classifyError(msg: string | null | undefined): {
  category: ErrorCategory;
  summary: string;
  hint: string;
} {
  if (!msg) return { category: "unknown", summary: "Unknown error", hint: "Open the details drawer for the raw error." };
  const m = msg.toLowerCase();
  if (/offline|unreachable|econnrefused|no route|not reachable|disconnected/.test(m))
    return { category: "offline", summary: "Printer is offline", hint: "Check power, cable, and network of the destination printer." };
  if (/out of paper|paper empty|no paper|paper jam|cover open|drawer open/.test(m))
    return { category: "out-of-paper", summary: "Printer needs attention", hint: "Load paper / close the cover, then retry." };
  if (/driver|no driver|driver not registered|unsupported op/.test(m))
    return { category: "driver-missing", summary: "No driver available for this printer", hint: "Assign a driver from Hardware · Devices." };
  if (/permission|access denied|unauthorized|forbidden|not permitted/.test(m))
    return { category: "permission", summary: "Permission denied", hint: "Grant USB / print access on this workstation." };
  if (/timeout|timed out|deadline/.test(m))
    return { category: "timeout", summary: "The printer did not respond in time", hint: "Retry, or check that the printer is powered and reachable." };
  const firstLine = msg.split(/\n|\r/).find((l) => l.trim().length > 0) ?? msg;
  return { category: "unknown", summary: firstLine.slice(0, 140), hint: "Open the details drawer for the full error." };
}

/** Short, non-technical elapsed-time label between two timestamps. */
export function durationLabel(fromIso: string | null, toIso: string | null): string {
  if (!fromIso || !toIso) return "—";
  const ms = new Date(toIso).getTime() - new Date(fromIso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  return `${Math.round(ms / 3_600_000)} h`;
}

/** Human date + time in the current locale, e.g. "27 Jul, 14:02". */
export function shortDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  if (sameDay) return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleString(undefined, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** Last 8 chars of a UUID — engineer-mode fallback identifier. */
export function shortId(id: string | null | undefined): string {
  if (!id) return "—";
  return id.length > 8 ? `…${id.slice(-8)}` : id;
}

function prettifyEnum(v: string): string {
  return v
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}