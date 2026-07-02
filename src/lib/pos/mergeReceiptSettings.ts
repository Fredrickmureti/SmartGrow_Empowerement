/**
 * Stage B — shared receipt-settings merger.
 *
 * Mirrors the behavior of useMergedReceiptSettings but works on plain values
 * so it can be applied to a frozen snapshot (where both raw rows are stored)
 * as well as live data. Keep this in sync with POS_OVERRIDE_FIELDS.
 */
import { POS_OVERRIDE_FIELDS } from "@/hooks/pos/useMergedReceiptSettings";
import type { ExtendedReceiptSettings } from "@/types/receipt";

export function mergeReceiptSettings(
  globalSettings: Partial<ExtendedReceiptSettings> | null | undefined,
  posOverrides: Partial<ExtendedReceiptSettings> | null | undefined,
): ExtendedReceiptSettings {
  const base = { ...(globalSettings ?? {}) } as Record<string, unknown>;
  if (posOverrides) {
    for (const field of POS_OVERRIDE_FIELDS) {
      const v = (posOverrides as Record<string, unknown>)[field];
      if (v !== undefined && v !== null) {
        base[field] = v;
      }
    }
  }
  // Phase C — UI ↔ builder token aliasing for item_display_format. Keeps
  // the live preview and the printed receipt in lock-step.
  const ITEM_FORMAT_ALIAS: Record<string, string> = {
    compact: "single-line",
    detailed: "two-lines",
    tabular: "tabular",
  };
  const fmt = base.item_display_format;
  if (typeof fmt === "string" && ITEM_FORMAT_ALIAS[fmt]) {
    base.item_display_format = ITEM_FORMAT_ALIAS[fmt];
  }
  return base as unknown as ExtendedReceiptSettings;
}