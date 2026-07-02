/**
 * Shared POS receipt-settings merger (Deno + Vite safe).
 *
 * Mirrors `src/lib/pos/mergeReceiptSettings.ts` and
 * `src/hooks/pos/useMergedReceiptSettings.ts::POS_OVERRIDE_FIELDS`. Kept
 * pure (no Supabase imports, no React) so the same logic feeds the
 * server-side ESC/POS renderer and the client-side preview.
 *
 * Rule: company-level (`businesses.receipt_settings`) is the canonical
 * source of truth for branding / sections / content. The POS register
 * (`pos_settings.receipt_settings`) may ONLY override a small whitelist
 * of terminal-specific fields. Anything else from the register row is
 * IGNORED so global toggles can never be silently shadowed.
 */

export const POS_OVERRIDE_FIELDS = [
  "paper_size",
  "auto_print_receipt",
  "font_size",
  "line_spacing",
  "item_display_format",
  "show_tax_breakdown",
  "show_savings",
  "show_cashier_name",
  "cashier_label_format",
  "show_item_sku",
  "receipt_header",
  "receipt_footer",
] as const;

export type POSOverrideField = (typeof POS_OVERRIDE_FIELDS)[number];

export function mergeReceiptSettings(
  globalSettings: Record<string, unknown> | null | undefined,
  posOverrides: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const base: Record<string, unknown> = { ...(globalSettings ?? {}) };
  if (posOverrides) {
    for (const field of POS_OVERRIDE_FIELDS) {
      const v = posOverrides[field];
      if (v !== undefined && v !== null) {
        base[field] = v;
      }
    }
  }
  // UI <-> builder token aliasing for item_display_format. The settings UI
  // exposes user-friendly labels (`compact` / `detailed` / `tabular`) but
  // the ESC/POS builder consumes the legacy spellings. Translate so a UI
  // change is never silently a no-op.
  const ITEM_FORMAT_ALIAS: Record<string, string> = {
    compact: "single-line",
    detailed: "two-lines",
    tabular: "tabular",
  };
  const fmt = base.item_display_format;
  if (typeof fmt === "string" && ITEM_FORMAT_ALIAS[fmt]) {
    base.item_display_format = ITEM_FORMAT_ALIAS[fmt];
  }
  return base;
}
