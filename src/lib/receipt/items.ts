/**
 * Client mirror of supabase/functions/_shared/receipt/items.ts
 *
 * Identical body — only the import paths differ (alias-resolved here,
 * relative on the Deno side). Keep these two files in lockstep.
 */
import {
  solveColumns,
  renderHeader,
  renderRow,
  padLR,
  type SolvedColumn,
} from "@/lib/receipt/engine/ColumnLayout";
import {
  LAYOUT_REGISTRY,
  type LayoutId,
  type LayoutContext,
} from "@/lib/receipt/layouts";
import { resolveDisplayUnitPrice } from "@/lib/documents/lineItemPrice";

export type ItemRowKind = "heading" | "header" | "item" | "subrow";

export interface AssembledItemRow {
  kind: ItemRowKind;
  text: string;
  bold?: boolean;
  /** Index into the input `items` array, or null for heading/header rows. */
  itemIndex: number | null;
}

export type AssembleItemsCtx = LayoutContext;

export interface ItemFormatter {
  fmtMoney: (n: number) => string;
  fmtQty: (n: number) => string;
  truncate: (s: string, max: number) => string;
}

export interface RawItem {
  product_name?: string;
  description?: string;
  sku?: string | null;
  quantity?: number;
  unit_price?: number;
  line_total?: number;
  discount_amount?: number;
  tax_amount?: number;
  tax_rate?: number;
  tax_rate_name?: string;
  // Multi-unit pack provenance.
  display_quantity?: number | null;
  packaging_label?: string | null;
  base_uom_label?: string | null;
  [k: string]: unknown;
}

export interface AssembleItemsInput {
  items: RawItem[];
  layoutId: LayoutId;
  ctx: AssembleItemsCtx;
  contentWidth: number;
  fmt: ItemFormatter;
}

export interface AssembleItemsResult {
  rows: AssembledItemRow[];
  solved: SolvedColumn[];
  layoutId: LayoutId;
}

export function assembleItems(input: AssembleItemsInput): AssembleItemsResult {
  const { items, layoutId, ctx, contentWidth: cw, fmt } = input;
  const template = LAYOUT_REGISTRY[layoutId];
  const colSpecs = template.columns(ctx);
  const solved = solveColumns(colSpecs, cw, 1);
  const rows: AssembledItemRow[] = [];

  if (template.heading) {
    rows.push({ kind: "heading", text: template.heading, bold: true, itemIndex: null });
  }
  if (template.showHeader) {
    rows.push({ kind: "header", text: renderHeader(solved, 1), bold: true, itemIndex: null });
  }

  for (let idx = 0; idx < items.length; idx++) {
    const it = items[idx];
    const qty = Number(it.quantity ?? 0);
    const baseUnitPrice = Number(it.unit_price ?? 0);
    const total = Number(it.line_total ?? qty * baseUnitPrice);
    const baseName = String(it.product_name ?? it.description ?? "Item");
    const nameStr = ctx.truncateLongNames ? fmt.truncate(baseName, ctx.maxNameLen) : baseName;

    const displayQty = it.display_quantity != null && Number.isFinite(Number(it.display_quantity))
      ? Number(it.display_quantity)
      : qty;
    const packLabel = (it.packaging_label ?? "").toString().trim();
    const qtyCell = packLabel
      ? `${fmt.fmtQty(displayQty)} ${packLabel}`
      : fmt.fmtQty(qty);

    const values: Record<string, string> = {
      sku: String(it.sku ?? ""),
      name: nameStr,
      qty: ctx.showQty ? qtyCell : "",
      unit: fmt.fmtMoney(price),
      total: fmt.fmtMoney(total),
    };

    if (template.itemShape === "two-row") {
      for (const r of renderRow(values, solved, 1)) {
        rows.push({ kind: "item", text: r, itemIndex: idx });
      }
      if (ctx.showSku && it.sku) {
        rows.push({ kind: "subrow", text: "  SKU: " + String(it.sku), itemIndex: idx });
      }
      const leftParts: string[] = [];
      if (ctx.showQty) leftParts.push(qtyCell);
      if (ctx.showUnitPrice) leftParts.push(`x ${fmt.fmtMoney(price)}`);
      const leftLbl = "  " + (leftParts.length ? leftParts.join(" ") : "");
      rows.push({ kind: "subrow", text: padLR(leftLbl, fmt.fmtMoney(total), cw), itemIndex: idx });
    } else {
      for (const r of renderRow(values, solved, 1)) {
        rows.push({ kind: "item", text: r, itemIndex: idx });
      }
      if (ctx.showUnitPrice && it.unit_price != null && layoutId !== "compact") {
        rows.push({ kind: "subrow", text: padLR("  @ " + fmt.fmtMoney(price), "", cw), itemIndex: idx });
      }
    }

    if (ctx.showDiscount && Number(it.discount_amount ?? 0) > 0) {
      rows.push({
        kind: "subrow",
        text: padLR("  Discount", `-${fmt.fmtMoney(Number(it.discount_amount))}`, cw),
        itemIndex: idx,
      });
    }
    if (ctx.showTaxBreakdown && Number(it.tax_amount ?? 0) > 0) {
      const rateLabel = ctx.showTaxRate && it.tax_rate != null
        ? ` ${Number(it.tax_rate).toFixed(0)}%`
        : "";
      const nameLabel = String(it.tax_rate_name ?? "Tax");
      rows.push({
        kind: "subrow",
        text: padLR(`  ${nameLabel}${rateLabel}`, fmt.fmtMoney(Number(it.tax_amount)), cw),
        itemIndex: idx,
      });
    }
  }

  return { rows, solved, layoutId };
}
