/**
 * flatToTheme / themeToFlat — Phase B.3 lossless mappers between the legacy
 * flat `ExtendedReceiptSettings` and the structured `ReceiptTheme`.
 *
 * Lossless on the rendering-relevant subset of fields. Round-trip tested in
 * `src/test/receipt/flat-theme-roundtrip.test.ts`.
 *
 * Mirror at `supabase/functions/_shared/receipt/migrations/flatToTheme.ts`.
 */
import type { ExtendedReceiptSettings } from "@/types/receipt";
import {
  type ReceiptTheme,
  type ThemePaperSize,
  type ThemeFont,
  type DensityPreset,
  DEFAULT_SECTION_ORDER,
} from "@/types/receiptTheme";
import { resolveLegacyLayout } from "@/lib/receipt/layouts";

function paperFromFlat(p: ExtendedReceiptSettings["paper_size"]): ThemePaperSize {
  switch (p) {
    case "40mm":
    case "58mm":
    case "80mm":
    case "A4":
    case "A5":
    case "Letter":
      return p;
    default:
      return "80mm";
  }
}

function fontFromFlat(fs: ExtendedReceiptSettings["font_size"]): ThemeFont {
  // 'small' → ESC/POS Font B; 'medium' / 'large' → Font A.
  return fs === "small" ? "B" : "A";
}

function densityFromFlat(ls: ExtendedReceiptSettings["line_spacing"]): DensityPreset {
  if (ls === "compact") return "compact";
  if (ls === "relaxed") return "spacious";
  return "standard";
}

function lineSpacingFromDensity(d: DensityPreset): ExtendedReceiptSettings["line_spacing"] {
  if (d === "compact") return "compact";
  if (d === "spacious") return "relaxed";
  return "normal";
}

function fontFromTheme(font: ThemeFont, src: ExtendedReceiptSettings["font_size"]): ExtendedReceiptSettings["font_size"] {
  // Preserve large vs medium when round-tripping; only 'B' deterministically maps to 'small'.
  if (font === "B") return "small";
  return src === "large" ? "large" : "medium";
}

export function flatToTheme(flat: ExtendedReceiptSettings): ReceiptTheme {
  const layoutId = resolveLegacyLayout(flat.item_display_format, !!flat.show_item_sku);
  const fontA = fontFromFlat(flat.font_size);

  return {
    schemaVersion: 1,
    paper: {
      size: paperFromFlat(flat.paper_size),
      marginCols: (flat as unknown as { margin_cols?: number }).margin_cols,
    },
    density: {
      preset: densityFromFlat(flat.line_spacing),
    },
    typography: {
      font: fontA,
      emphasizeTotals: true,
      doubleHeightTitle: flat.font_size === "large",
    },
    branding: {
      showLogo: !!flat.show_logo,
      logoSize: flat.logo_size ?? "medium",
      primaryColor: flat.primary_color,
    },
    header: {
      align: flat.header_align ?? "center",
      show: {
        storeName: !!flat.show_store_name,
        address: !!flat.show_store_address,
        phone: !!flat.show_store_phone,
        email: !!flat.show_store_email,
        taxId: false,
      },
      customText: flat.receipt_header || undefined,
    },
    meta: {
      align: flat.meta_align ?? "center",
      show: {
        receiptNumber: !!flat.show_receipt_number,
        dateTime: !!flat.show_date_time,
        cashier: !!flat.show_cashier_name,
        register: !!flat.show_register_id,
        customer: !!flat.show_customer_name,
      },
      cashierLabel: flat.cashier_label_format === "served_by" ? "Served by" : "Cashier",
    },
    items: {
      layoutId,
      show: {
        sku: !!flat.show_item_sku,
        qty: !!flat.show_item_quantity,
        unitPrice: !!flat.show_unit_price,
        discount: !!flat.show_item_discount,
        modifiers: flat.show_item_modifiers ?? true,
        taxRate: !!flat.show_tax_rate,
        taxBreakdown: !!flat.show_tax_breakdown,
      },
      truncate: {
        enabled: !!flat.truncate_long_names,
        maxNameLen: flat.max_item_name_length ?? 28,
      },
    },
    totals: {
      align: flat.totals_align ?? "left",
      show: {
        subtotal: !!flat.show_subtotal,
        discount: !!flat.show_discount_total,
        tax: !!flat.show_tax_breakdown,
        savings: !!flat.show_savings,
      },
      emphasizeGrandTotal: true,
    },
    payment: {
      show: {
        method: !!flat.show_payment_method,
        tendered: !!flat.show_amount_tendered,
        change: !!flat.show_change_due,
      },
    },
    footer: {
      align: flat.footer_align ?? "center",
      customText: flat.receipt_footer || undefined,
      returnPolicy: flat.show_return_policy
        ? { enabled: true, text: flat.return_policy_text ?? "" }
        : undefined,
      showBarcode: !!flat.show_barcode,
      showQrCode: !!flat.show_qr_code,
    },
    formatting: {
      currency: {
        display: flat.currency_display ?? "code",
        position: flat.currency_position ?? "before",
        symbolOverride: flat.currency_symbol_override || undefined,
        decimals: flat.decimal_places ?? 2,
        thousands: flat.thousands_separator ?? ",",
      },
      date: flat.date_format ?? "iso",
      time: flat.time_format ?? "24h",
    },
    compliance: {
      etims: {
        showInfo: !!flat.show_etims_info,
        showQr: !!flat.show_etims_qr,
      },
    },
    print: {
      autoPrint: !!flat.auto_print_receipt,
      copies: Math.max(1, Math.min(3, flat.copies ?? 1)),
      copyLabels: flat.copy_labels && flat.copy_labels.length > 0 ? flat.copy_labels : undefined,
      cutMode: flat.cut_mode ?? "full",
      feedLinesAfter: Math.max(0, Math.min(10, flat.feed_lines_after ?? 4)),
    },
    sectionOrder: [...DEFAULT_SECTION_ORDER],
  };
}

/**
 * Inverse mapping. Used by the legacy editor write-path during the
 * `receipt_engine_v2` migration window so a single source of truth still
 * exists at rest.
 */
export function themeToFlat(theme: ReceiptTheme, fallback: ExtendedReceiptSettings): ExtendedReceiptSettings {
  const layoutFormat: ExtendedReceiptSettings["item_display_format"] =
    theme.items.layoutId === "detailed"
      ? "two-lines"
      : theme.items.layoutId === "tabular" || theme.items.layoutId === "tabular_sku"
      ? "tabular"
      : "single-line";

  return {
    ...fallback,
    paper_size: theme.paper.size,
    template: fallback.template,
    font_size: fontFromTheme(theme.typography.font, fallback.font_size),
    line_spacing: lineSpacingFromDensity(theme.density.preset),

    show_logo: theme.branding.showLogo,
    logo_size: theme.branding.logoSize,
    primary_color: theme.branding.primaryColor ?? fallback.primary_color,

    receipt_header: theme.header.customText ?? "",
    show_store_name: theme.header.show.storeName,
    show_store_address: theme.header.show.address,
    show_store_phone: theme.header.show.phone,
    show_store_email: theme.header.show.email,

    show_receipt_number: theme.meta.show.receiptNumber,
    show_date_time: theme.meta.show.dateTime,
    show_cashier_name: theme.meta.show.cashier,
    cashier_label_format: theme.meta.cashierLabel === "Served by" ? "served_by" : "cashier",
    show_register_id: theme.meta.show.register,
    show_customer_name: theme.meta.show.customer,

    show_item_sku: theme.items.show.sku,
    show_item_quantity: theme.items.show.qty,
    show_unit_price: theme.items.show.unitPrice,
    show_item_discount: theme.items.show.discount,
    truncate_long_names: theme.items.truncate.enabled,
    max_item_name_length: theme.items.truncate.maxNameLen,
    item_display_format: layoutFormat,

    show_subtotal: theme.totals.show.subtotal,
    show_discount_total: theme.totals.show.discount,
    show_tax_breakdown: theme.totals.show.tax,
    show_tax_rate: theme.items.show.taxRate,
    show_savings: theme.totals.show.savings,

    show_payment_method: theme.payment.show.method,
    show_amount_tendered: theme.payment.show.tendered,
    show_change_due: theme.payment.show.change,

    receipt_footer: theme.footer.customText ?? "",
    show_return_policy: !!theme.footer.returnPolicy?.enabled,
    return_policy_text: theme.footer.returnPolicy?.text ?? "",
    show_barcode: theme.footer.showBarcode,
    show_qr_code: theme.footer.showQrCode,

    show_etims_info: theme.compliance.etims.showInfo,
    show_etims_qr: theme.compliance.etims.showQr,

    auto_print_receipt: theme.print.autoPrint,

    header_align: theme.header.align,
    meta_align: theme.meta.align,
    items_header_align: fallback.items_header_align ?? "left",
    totals_align: theme.totals.align,
    footer_align: theme.footer.align,

    currency_display: theme.formatting.currency.display,
    currency_position: theme.formatting.currency.position,
    currency_symbol_override: theme.formatting.currency.symbolOverride ?? "",
    decimal_places: theme.formatting.currency.decimals,
    thousands_separator: theme.formatting.currency.thousands,

    date_format: theme.formatting.date,
    time_format: theme.formatting.time,

    show_item_modifiers: theme.items.show.modifiers,
    show_refund_banner: fallback.show_refund_banner ?? true,
    copies: theme.print.copies,
    copy_labels: theme.print.copyLabels ?? [],
    cut_mode: theme.print.cutMode,
    feed_lines_after: theme.print.feedLinesAfter,
  };
}
