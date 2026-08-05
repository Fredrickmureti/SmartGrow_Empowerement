/**
 * Scanned-token dispatcher (ADR-0110, Phase 7).
 *
 * ONE place decides *what kind of thing* a scanned token is, BEFORE any
 * resolver is called. Without this, every surface asks its own resolver
 * and reports the resolver's failure — so scanning a GS1 product label at
 * a "scan the bin" prompt says "no location matches 05012345678900",
 * which is both wrong and unactionable. The operator scanned a product;
 * the prompt wanted a position.
 *
 * The classifier is pure, offline-safe, and shares the identity grammar
 * from `@/lib/gs1/identityCodes` — it never invents a second normaliser.
 *
 * Rules, most specific first:
 *   1. GS1 element string with AI (00)      → `sscc` (handling unit).
 *   2. GS1 element string with AI (414)     → `location` (GLN of a party/place).
 *   3. GS1 element string with AI (01)      → `product` (plus lot/serial/expiry).
 *   4. Bare 18 digits                       → `sscc`.
 *   5. Bare 8/12/13/14 digits               → `product` (GTIN padding family).
 *   6. Position-shaped code (segments)      → `location` (e.g. `A-01-02-3`).
 *   7. Anything else                        → `opaque` (SKU, LPN, doc no.).
 *
 * `opaque` is deliberately permissive: a surface expecting an LPN, a SKU
 * or a document number must still try its own resolver. The classifier
 * only ever REFUSES a scan when the token is positively identified as a
 * different kind of thing.
 */
import { parseGs1 } from "@/lib/gs1/parseGs1";
import { identityCodeCandidates, normalizeIdentityCode } from "@/lib/gs1/identityCodes";

export type ScanTokenKind = "product" | "location" | "sscc" | "opaque" | "empty";

export interface ClassifiedScanToken {
  kind: ScanTokenKind;
  /** `upper(btrim(raw))` — the canonical form of the whole token. */
  norm: string;
  /** Code to hand to the resolver for this kind (GTIN for GS1 product, etc). */
  resolveCode: string;
  /** Candidate codes for a product match; empty for non-product kinds. */
  candidates: string[];
  /** True when the token parsed as a GS1 element string. */
  isGs1: boolean;
  /** GS1 attributes carried on the label, when present. */
  lot: string | null;
  serial: string | null;
  expiry: Date | null;
  /**
   * `true` when the kind is a positive identification (a refusal is safe),
   * `false` for `opaque`, where the surface must still try its resolver.
   */
  certain: boolean;
}

/** Position codes look like `A-01-02`, `A.1.2`, `RCV/DOCK/01`, `AISLE_3`. */
const POSITION_SHAPED = /^[A-Z0-9]+(?:[-._/][A-Z0-9]+){1,5}$/;

function empty(): ClassifiedScanToken {
  return {
    kind: "empty",
    norm: "",
    resolveCode: "",
    candidates: [],
    isGs1: false,
    lot: null,
    serial: null,
    expiry: null,
    certain: false,
  };
}

export function classifyScanToken(raw: string): ClassifiedScanToken {
  const norm = normalizeIdentityCode(raw ?? "");
  if (!norm) return empty();

  const parsed = parseGs1((raw ?? "").trim());
  const g = parsed.ok ? parsed.normalized : null;
  const base: ClassifiedScanToken = {
    kind: "opaque",
    norm,
    resolveCode: norm,
    candidates: [],
    isGs1: Boolean(parsed.ok),
    lot: g?.lot ?? null,
    serial: g?.serial ?? null,
    expiry: g?.expiry ?? null,
    certain: false,
  };

  if (g) {
    if (g.sscc) return { ...base, kind: "sscc", resolveCode: g.sscc, certain: true };
    if (g.gln) return { ...base, kind: "location", resolveCode: g.gln, certain: true };
    if (g.gtin) {
      return {
        ...base,
        kind: "product",
        resolveCode: g.gtin,
        candidates: identityCodeCandidates(raw),
        certain: true,
      };
    }
  }

  if (/^[0-9]{18}$/.test(norm)) return { ...base, kind: "sscc", certain: true };

  if (/^[0-9]{8}$|^[0-9]{12,14}$/.test(norm)) {
    return { ...base, kind: "product", candidates: identityCodeCandidates(raw), certain: true };
  }

  if (POSITION_SHAPED.test(norm)) return { ...base, kind: "location", certain: false };

  return base;
}

const KIND_NOUN: Record<ScanTokenKind, string> = {
  product: "a product barcode",
  location: "a position label",
  sscc: "a pallet / carton (SSCC) label",
  opaque: "an unrecognised label",
  empty: "an empty scan",
};

const EXPECTED_NOUN: Record<Exclude<ScanTokenKind, "empty" | "opaque">, string> = {
  product: "the product barcode",
  location: "the position label",
  sscc: "the pallet / carton label",
};

/**
 * Operator copy for a positively-misdirected scan, or `null` when the
 * token is acceptable for the expected kind (including every `opaque`
 * token, which the caller's own resolver must adjudicate).
 */
export function describeTokenMismatch(
  token: ClassifiedScanToken,
  expected: Exclude<ScanTokenKind, "empty" | "opaque">,
): string | null {
  if (token.kind === "empty") return null;
  if (token.kind === expected) return null;
  if (!token.certain) return null;
  return `That is ${KIND_NOUN[token.kind]} — scan ${EXPECTED_NOUN[expected]} instead.`;
}
