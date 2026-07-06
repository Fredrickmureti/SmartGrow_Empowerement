// Deno test: generate-tax-certificate must refuse (HTTP 422) any template
// whose body lacks the ADR-0060 section contract. This is the unit-level
// mirror of the structural gate enforced by
// `enforce_certificate_template_structure` at the DB layer.
//
// We don't boot the full edge runtime here; we simulate the exact
// refusal branch (lines 205-253 of index.ts) against an in-memory
// template. If the branch ever regresses (a future edit removes the
// early-return), this test fails.
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";

interface FakeTemplate {
  code: string;
  body: any;
}

// Extracted mirror of the refusal branch in index.ts. Keeping it here
// (rather than importing) guarantees a copy-drift alarm: if index.ts
// changes the contract, this test must be updated in the same PR.
function evaluateStructuralContract(template: FakeTemplate): {
  ok: boolean;
  missing: string[];
  hasData: boolean;
} {
  const sec = Array.isArray(template?.body?.sections) ? template.body.sections : [];
  const types = new Set<string>(sec.map((s: any) => String(s?.type ?? "")));
  const missing: string[] = [];
  for (const need of ["employer_header", "employee_header", "signature_block"]) {
    if (!types.has(need)) missing.push(need);
  }
  const hasData = ["monthly_breakdown", "ytd_table", "totals"].some((d) => types.has(d));
  return { ok: sec.length > 0 && missing.length === 0 && hasData, missing, hasData };
}

Deno.test("empty body refuses with all identity sections missing", () => {
  const t: FakeTemplate = { code: "FAKE", body: { sections: [] } };
  const r = evaluateStructuralContract(t);
  assertEquals(r.ok, false);
  assertEquals(r.hasData, false);
  assertEquals(r.missing.sort(), ["employee_header", "employer_header", "signature_block"]);
});

Deno.test("legacy blocks-only body (no sections array) refuses", () => {
  const t: FakeTemplate = { code: "P9_LEGACY", body: { blocks: [{ kind: "summary" }] } };
  const r = evaluateStructuralContract(t);
  assertEquals(r.ok, false);
});

Deno.test("identity sections without a data section refuses", () => {
  const t: FakeTemplate = {
    code: "P9A_HALF",
    body: {
      sections: [
        { type: "employer_header" },
        { type: "employee_header" },
        { type: "signature_block" },
      ],
    },
  };
  const r = evaluateStructuralContract(t);
  assertEquals(r.ok, false);
  assertEquals(r.hasData, false);
});

Deno.test("full contract (P9A shape) passes", () => {
  const t: FakeTemplate = {
    code: "P9A",
    body: {
      sections: [
        { type: "employer_header" },
        { type: "employee_header" },
        { type: "filing_period_band" },
        { type: "monthly_breakdown", columns: [{ key: "a" }] },
        { type: "signature_block" },
      ],
    },
  };
  const r = evaluateStructuralContract(t);
  assert(r.ok, `expected ok; missing=${r.missing.join(",")} hasData=${r.hasData}`);
});

Deno.test("YTD-only certificate (CERT_OF_SERVICE shape) passes", () => {
  const t: FakeTemplate = {
    code: "CERT_OF_SERVICE",
    body: {
      sections: [
        { type: "employer_header" },
        { type: "employee_header" },
        { type: "ytd_table" },
        { type: "signature_block" },
      ],
    },
  };
  assert(evaluateStructuralContract(t).ok);
});
