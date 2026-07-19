/**
 * Phase 6.1 guard — HR letter document types must remain in the
 * persistence allowlist. Removing any of them would silently disable
 * audit-trail persistence for issued HR letters, breaking employee
 * record integrity (ADR-0084).
 */
import { assert } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { shouldPersistArtifact, isBlockingType } from "./persistArtifact.ts";

const HR_TYPES = [
  "offer_letter",
  "promotion_letter",
  "warning_letter",
  "contract_letter",
] as const;

Deno.test("Phase 6.1 — HR letters are persisted", () => {
  for (const t of HR_TYPES) {
    assert(shouldPersistArtifact(t), `${t} must persist by default`);
  }
});

Deno.test("Phase 6.1 — offer_letter and contract_letter block on persistence failure", () => {
  assert(isBlockingType("offer_letter"), "offer_letter must block");
  assert(isBlockingType("contract_letter"), "contract_letter must block");
});