/**
 * Thin adapter: given a raw scan payload, return the structured GS1
 * result (if any) alongside the "product-resolvable code" that legacy
 * scan resolvers expect.
 *
 * The hook is intentionally stateless — every scan surface (GRN wizard,
 * pickers, POS input) owns its own debounce/flash lifecycle. This
 * module only decides "is this GS1, and if so what is the GTIN".
 */
import { useCallback } from "react";
import { parseGs1, type Gs1Normalized } from "./parseGs1";

export interface Gs1ScanInterpretation {
  raw: string;
  /** Payload to hand to `useResolveBarcode` — GTIN when GS1, else raw. */
  resolveCode: string;
  isGs1: boolean;
  normalized: Gs1Normalized;
}

export function interpretScan(raw: string): Gs1ScanInterpretation {
  const trimmed = raw.trim();
  const parsed = parseGs1(trimmed);
  if (parsed.ok) {
    return {
      raw: trimmed,
      resolveCode: parsed.normalized.gtin ?? trimmed,
      isGs1: true,
      normalized: parsed.normalized,
    };
  }
  return { raw: trimmed, resolveCode: trimmed, isGs1: false, normalized: {} };
}

export function useGs1Scanner() {
  const interpret = useCallback(interpretScan, []);
  return { interpret };
}
