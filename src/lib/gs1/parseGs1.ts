/**
 * Pure GS1-128 / GS1 DataMatrix parser.
 *
 * Table-driven: every Application Identifier is described in
 * `./aiTable.ts`. This file MUST NOT import anything else — a guard
 * (`src/test/architecture/gs1-parsing.test.ts`) enforces the isolation
 * so the parser stays trivial to audit.
 *
 * Contract:
 *   parseGs1(raw)
 *     → { ok: true,  elements, normalized }  when at least one AI parses
 *     → { ok: false, error }                  when input is not GS1
 *
 * Unknown AIs are ignored (soft-fail with partial result) rather than
 * aborting the parse, because real-world labels frequently carry
 * industry-specific AIs we don't yet model.
 */
import { GS1_AI_TABLE, GS1_SYMBOLOGY_PREFIXES, FNC1, type AiSpec } from "./aiTable";

export interface Gs1Normalized {
  gtin?: string;
  lot?: string;
  serial?: string;
  expiry?: Date;
  productionDate?: Date;
  quantity?: number;
  netWeightKg?: number;
}

export type Gs1ParseResult =
  | { ok: true; elements: Record<string, string>; normalized: Gs1Normalized }
  | { ok: false; error: string };

// AI lookup keyed by 2-digit and 3-digit prefixes. `310n`-family entries
// are stored under their 3-digit prefix and matched with the 4th char
// as the decimal indicator.
const BY_PREFIX: Record<string, AiSpec> = Object.fromEntries(
  GS1_AI_TABLE.map((s) => [s.ai, s]),
);

function stripSymbology(input: string): string {
  for (const p of GS1_SYMBOLOGY_PREFIXES) {
    if (input.startsWith(p)) return input.slice(p.length);
  }
  return input;
}

function parseYymmdd(v: string): Date | undefined {
  if (!/^\d{6}$/.test(v)) return undefined;
  const yy = Number(v.slice(0, 2));
  const mm = Number(v.slice(2, 4));
  let dd = Number(v.slice(4, 6));
  // GS1 century rule: 51..99 → 19xx, 00..50 → 20xx.
  const year = yy >= 51 ? 1900 + yy : 2000 + yy;
  if (mm < 1 || mm > 12) return undefined;
  if (dd === 0) {
    // Last day of the month.
    dd = new Date(Date.UTC(year, mm, 0)).getUTCDate();
  }
  const d = new Date(Date.UTC(year, mm - 1, dd));
  return isNaN(d.getTime()) ? undefined : d;
}

/**
 * Match the AI at the current cursor. Returns the resolved spec plus
 * effective consumed prefix length (2 or 3 or 4 for `310n`-style).
 */
function matchAi(input: string, cursor: number): { spec: AiSpec; prefixLen: number; decimals?: number } | null {
  // Try 3-digit AI first (240, 241, 310n..316n), then 2-digit.
  const three = input.slice(cursor, cursor + 3);
  const threeSpec = BY_PREFIX[three];
  if (threeSpec) {
    if (threeSpec.decimalIndicator) {
      const decChar = input[cursor + 3];
      if (!decChar || !/\d/.test(decChar)) return null;
      return { spec: threeSpec, prefixLen: 4, decimals: Number(decChar) };
    }
    return { spec: threeSpec, prefixLen: 3 };
  }
  const two = input.slice(cursor, cursor + 2);
  const twoSpec = BY_PREFIX[two];
  if (twoSpec) return { spec: twoSpec, prefixLen: 2 };
  return null;
}

export function parseGs1(raw: string): Gs1ParseResult {
  if (typeof raw !== "string" || raw.length < 4) {
    return { ok: false, error: "empty or too short" };
  }
  let input = stripSymbology(raw);
  // Some scanners emit FNC1 at position 0; strip it — it carries no data.
  if (input.startsWith(FNC1)) input = input.slice(1);

  const elements: Record<string, string> = {};
  let cursor = 0;

  while (cursor < input.length) {
    const m = matchAi(input, cursor);
    if (!m) {
      // Not an AI at this position. Only fail if we haven't parsed
      // anything yet — otherwise stop cleanly with what we have.
      if (Object.keys(elements).length === 0) {
        return { ok: false, error: `unrecognised AI at position ${cursor}` };
      }
      break;
    }
    cursor += m.prefixLen;
    let value: string;
    if (m.spec.fixed !== undefined) {
      value = input.slice(cursor, cursor + m.spec.fixed);
      if (value.length < m.spec.fixed) {
        return { ok: false, error: `truncated fixed AI ${m.spec.ai}` };
      }
      cursor += m.spec.fixed;
    } else {
      // Variable length: read until FNC1 or end.
      const end = input.indexOf(FNC1, cursor);
      const stop = end === -1 ? Math.min(input.length, cursor + (m.spec.max ?? 48)) : end;
      value = input.slice(cursor, stop);
      cursor = end === -1 ? stop : end + 1;
    }
    // Decimal-indicator AIs share the same stored key; we record the
    // final numeric value under the AI name and skip raw-string echo.
    if (m.spec.decimalIndicator && m.decimals !== undefined) {
      elements[m.spec.name] = value;
      const asNum = Number(value) / Math.pow(10, m.decimals);
      if (m.spec.name === "netWeightKg") {
        // Stored below in `normalized`.
        (elements as Record<string, string>)["__" + m.spec.name] = String(asNum);
      }
    } else {
      elements[m.spec.name] = value;
    }
  }

  if (Object.keys(elements).length === 0) {
    return { ok: false, error: "no AIs parsed" };
  }

  const normalized: Gs1Normalized = {};
  if (elements.gtin) normalized.gtin = elements.gtin;
  if (elements.lot) normalized.lot = elements.lot;
  if (elements.serial) normalized.serial = elements.serial;
  if (elements.expiry) normalized.expiry = parseYymmdd(elements.expiry);
  if (elements.productionDate) normalized.productionDate = parseYymmdd(elements.productionDate);
  if (elements.count) {
    const n = Number(elements.count);
    if (!Number.isNaN(n)) normalized.quantity = n;
  }
  if (elements.__netWeightKg) normalized.netWeightKg = Number(elements.__netWeightKg);

  return { ok: true, elements, normalized };
}

/** Convenience: `true` iff the input looks like a GS1 payload. */
export function isGs1Payload(raw: string): boolean {
  return parseGs1(raw).ok;
}
