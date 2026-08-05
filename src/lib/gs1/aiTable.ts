/**
 * GS1 Application Identifier (AI) table.
 *
 * Data-only. `parseGs1.ts` is the sole consumer. Adding an AI here is
 * additive; removing one is a breaking change and requires ADR
 * amendment (0071).
 *
 * Length semantics:
 *   - `fixed`: AI value is exactly `fixed` characters. No FNC1 needed.
 *   - `max`  : AI value is variable, up to `max` characters, terminated
 *              by FNC1 (0x1D) or end of input.
 *   - `dateFormat: "YYMMDD"`: 6-digit calendar date, day may be `00`
 *              which resolves to the last day of the month (GS1 rule).
 *   - `decimalIndicator`: when `true`, the fourth AI digit is a decimal
 *              place indicator (e.g. `3103` → 3 decimals in the value).
 */

export interface AiSpec {
  ai: string;
  name: string;
  fixed?: number;
  max?: number;
  dateFormat?: "YYMMDD";
  decimalIndicator?: boolean;
}

/**
 * Ordered by AI prefix length descending inside the parser so `310n`
 * matches before a hypothetical `31`. Order here is documentation-only.
 */
export const GS1_AI_TABLE: AiSpec[] = [
  { ai: "00", name: "sscc", fixed: 18 },
  { ai: "01", name: "gtin", fixed: 14 },
  { ai: "02", name: "gtinContained", fixed: 14 },
  { ai: "10", name: "lot", max: 20 },
  { ai: "11", name: "productionDate", fixed: 6, dateFormat: "YYMMDD" },
  { ai: "13", name: "packagingDate", fixed: 6, dateFormat: "YYMMDD" },
  { ai: "15", name: "bestBefore", fixed: 6, dateFormat: "YYMMDD" },
  { ai: "17", name: "expiry", fixed: 6, dateFormat: "YYMMDD" },
  { ai: "20", name: "variant", fixed: 2 },
  { ai: "21", name: "serial", max: 20 },
  { ai: "30", name: "count", max: 8 },
  { ai: "37", name: "countOfUnits", max: 8 },
  { ai: "240", name: "additionalItemId", max: 30 },
  { ai: "241", name: "customerPart", max: 30 },
  // 414 — GLN of a physical location (bin/dock/door labels, ADR-0110 Phase 7).
  { ai: "414", name: "gln", fixed: 13 },
  // 310n..316n — measurement AIs with decimal indicator, 6-digit value.
  { ai: "310", name: "netWeightKg", fixed: 6, decimalIndicator: true },
  { ai: "311", name: "lengthM", fixed: 6, decimalIndicator: true },
  { ai: "312", name: "widthM", fixed: 6, decimalIndicator: true },
  { ai: "313", name: "depthM", fixed: 6, decimalIndicator: true },
  { ai: "314", name: "areaM2", fixed: 6, decimalIndicator: true },
  { ai: "315", name: "netVolumeL", fixed: 6, decimalIndicator: true },
  { ai: "316", name: "netVolumeM3", fixed: 6, decimalIndicator: true },
];

/** Symbology prefixes emitted by scanners in front of the raw payload. */
export const GS1_SYMBOLOGY_PREFIXES = ["]C1", "]e0", "]d2", "]Q3"];

/** FNC1 group separator (ASCII 0x1D / GS). */
// RENDERER-EXEMPT: GS1 FNC1 separator (barcode data payload), not an ESC/POS command byte.
export const FNC1 = "\x1d";
