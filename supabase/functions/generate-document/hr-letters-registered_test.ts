/**
 * Architecture guard (Phase 6.1 — ADR-0084).
 *
 * Ensures every HR letter type is:
 *   1. Recognised by the HR type-guard (`isHrLetterType`).
 *   2. Routed through the HR branch in `generate-document/index.ts`
 *      (never allowed to fall through into the sales `FETCHER_MAP`).
 *   3. Reachable via a dedicated fetcher in `hrLetterFetchers.ts`.
 *
 * This test intentionally reads the source files as text — the goal is
 * to catch a future refactor that silently removes the HR branch or
 * drops a supported type from the dispatcher.
 */

import { assert, assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { HR_LETTER_TYPES, isHrLetterType } from "./hrLetterFetchers.ts";

const HR_TYPES = ["offer_letter", "promotion_letter", "warning_letter", "contract_letter"] as const;

Deno.test("HR letter type guard recognises all four HR types", () => {
  assertEquals(HR_LETTER_TYPES.size, HR_TYPES.length);
  for (const t of HR_TYPES) {
    assert(isHrLetterType(t), `expected ${t} to be an HR letter type`);
  }
  assert(!isHrLetterType("invoice"), "invoice must not be classified as HR");
  assert(!isHrLetterType("bill"), "bill must not be classified as HR");
});

Deno.test("generate-document routes HR letters through the HR branch (never sales FETCHER_MAP)", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  assert(
    src.includes("isHrLetterType(documentType)"),
    "generate-document/index.ts must gate HR letters via isHrLetterType",
  );
  assert(
    src.includes("generateHrLetterPdf"),
    "generate-document/index.ts must call generateHrLetterPdf for HR letters",
  );
  // The HR branch must precede the FETCHER_MAP dispatch — otherwise HR
  // types would fail with "Unsupported document type".
  const hrIdx = src.indexOf("isHrLetterType(documentType)");
  const fetcherIdx = src.indexOf("const fetcher = FETCHER_MAP[documentType]");
  assert(hrIdx > 0 && fetcherIdx > 0 && hrIdx < fetcherIdx,
    "HR branch must run BEFORE the sales FETCHER_MAP dispatch");
});

Deno.test("HR letter dispatcher covers every declared HR type", async () => {
  const src = await Deno.readTextFile(new URL("./hrLetterFetchers.ts", import.meta.url));
  for (const t of HR_TYPES) {
    assert(src.includes(`case "${t}"`), `fetchHrLetter must handle case "${t}"`);
  }
});