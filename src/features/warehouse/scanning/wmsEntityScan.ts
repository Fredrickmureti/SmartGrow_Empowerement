/**
 * WMS handling-unit / document scan contract (Phase 2).
 *
 * `useWmsIdentityGate` answers "which product is this?" and
 * `useResolveLocationIdentity` answers "which position is this?". Every
 * other thing an operator scans in a warehouse — an LPN, a sealed carton,
 * a loading manifest, a trailer, a gate pass, an ASN — had no shared
 * seam, so each screen invented its own `.toLowerCase()` compare against
 * whatever list it happened to have in memory. That is why dispatch could
 * accept a product barcode as a carton and say "No sealed carton with
 * that LPN".
 *
 * This module supplies the missing half of the identity layer:
 *
 *   1. A typed entity vocabulary shared by every non-product,
 *      non-position scan prompt.
 *   2. `gateEntityToken()` — the same token-kind dispatch products and
 *      positions already get, so a *positively identified* wrong kind is
 *      refused with operator copy BEFORE any lookup runs.
 *   3. `normalizeEntityCode()` — one canonical comparison form
 *      (`upper(btrim())`), so code matching never depends on which screen
 *      wrote the compare.
 *
 * Resolution itself stays with the caller: a carton resolves against the
 * manifest's available list, a trailer against the yard. The gate governs
 * *admission*, not lookup.
 */
import { classifyScanToken, type ScanTokenKind } from "@/lib/scan/classifyScanToken";
import { normalizeIdentityCode } from "@/lib/gs1/identityCodes";

/** Non-product, non-position things an operator scans. */
export type WmsEntityKind =
  | "lpn"
  | "carton"
  | "manifest"
  | "trailer"
  | "gate_pass"
  | "yard_slot"
  | "asn";

interface EntityRule {
  /** Operator-facing noun used in prompts and refusals. */
  noun: string;
  /** Token kinds that may legitimately carry this entity's label. */
  accepts: ScanTokenKind[];
  /** Default placeholder for the scan input. */
  placeholder: string;
}

/**
 * Handling units are commonly labelled either as an SSCC (GS1 AI 00) or as
 * a site-local opaque code (`LPN-000123`, `CTN-4471`). Documents and
 * vehicles are always opaque. No entity here is ever a GTIN or a position
 * label, which is exactly what makes the refusal safe.
 */
const RULES: Record<WmsEntityKind, EntityRule> = {
  lpn:       { noun: "a license plate (LPN)",  accepts: ["sscc", "opaque"], placeholder: "Scan the LPN label" },
  carton:    { noun: "a carton label",         accepts: ["sscc", "opaque"], placeholder: "Scan the carton label" },
  manifest:  { noun: "a loading manifest",     accepts: ["opaque"],         placeholder: "Scan the manifest" },
  trailer:   { noun: "a trailer plate",        accepts: ["opaque"],         placeholder: "Scan the trailer plate" },
  gate_pass: { noun: "a gate pass",            accepts: ["opaque"],         placeholder: "Scan the gate pass" },
  yard_slot: { noun: "a yard slot or dock label", accepts: ["opaque"],      placeholder: "Scan the slot or dock label" },
  asn:       { noun: "an inbound ASN",         accepts: ["opaque"],         placeholder: "Scan the ASN document" },
};

export function describeEntity(kind: WmsEntityKind): string {
  return RULES[kind].noun;
}

export function entityPlaceholder(kind: WmsEntityKind): string {
  return RULES[kind].placeholder;
}

/** One canonical comparison form for every entity code compare. */
export function normalizeEntityCode(raw: string): string {
  return normalizeIdentityCode(raw ?? "");
}

/** Case- and whitespace-insensitive equality for entity codes. */
export function entityCodeEquals(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeEntityCode(a ?? "");
  const nb = normalizeEntityCode(b ?? "");
  return na.length > 0 && na === nb;
}

export interface GatedEntityToken {
  /** Canonical code to hand to the caller's lookup. */
  code: string;
  /** SSCC when the label was a GS1 handling-unit barcode. */
  sscc: string | null;
  /** Rejection copy when the scan is positively the wrong kind of thing. */
  refusal: string | null;
}

/**
 * Admit or refuse a scanned token for an entity prompt. A refusal is only
 * ever issued for a *certain* mismatch (a GTIN or a position label); an
 * unrecognised opaque code is admitted so the caller's own lookup — which
 * knows the site's LPN grammar — makes the final call.
 */
export function gateEntityToken(raw: string, kind: WmsEntityKind): GatedEntityToken {
  const token = classifyScanToken(raw ?? "");
  const rule = RULES[kind];
  const code = token.kind === "sscc" ? token.resolveCode : token.norm;

  if (token.kind === "empty") return { code: "", sscc: null, refusal: null };

  if (!rule.accepts.includes(token.kind) && token.certain) {
    const scanned =
      token.kind === "product" ? "a product barcode"
      : token.kind === "location" ? "a position label"
      : "a pallet / carton (SSCC) label";
    return { code, sscc: null, refusal: `That is ${scanned} — scan ${rule.noun} instead.` };
  }

  return { code, sscc: token.kind === "sscc" ? token.resolveCode : null, refusal: null };
}