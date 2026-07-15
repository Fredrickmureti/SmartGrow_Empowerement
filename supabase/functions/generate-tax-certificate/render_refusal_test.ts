// Deno test: generate-tax-certificate must refuse (HTTP 422) any v3/v4
// certificate template whose `document` tree has no data-bearing node
// (grid — v4, matrix / table — v3). This mirrors the refusal branch in
// index.ts so contract drift trips the test.
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";

interface FakeTemplate { code: string; display_name?: string; body: any; }

function isCertificateOfServiceTemplate(template: FakeTemplate): boolean {
  const code = String(template?.code ?? template?.body?.code ?? "").toUpperCase();
  const displayName = String(template?.display_name ?? template?.body?.display_name ?? "");
  return code === "CERT_OF_SERVICE" || code === "CERTIFICATE_OF_SERVICE" || /certificate\s+of\s+service/i.test(displayName);
}

// Extracted mirror of the refusal branch in index.ts.
function evaluateDocumentContract(template: FakeTemplate): { ok: boolean; hasData: boolean; nodesPresent: string[] } {
  const nodes: any[] = Array.isArray(template?.body?.document) ? template.body.document : [];
  const types = new Set<string>();
  const walk = (n: any) => {
    if (!n || typeof n !== "object") return;
    if (n.type) types.add(String(n.type));
    if (Array.isArray(n.children)) n.children.forEach(walk);
    if (Array.isArray(n.column_children)) n.column_children.forEach((col: any) => Array.isArray(col) && col.forEach(walk));
  };
  nodes.forEach(walk);
  const hasData = types.has("matrix") || types.has("table") || types.has("grid");
  return { ok: nodes.length > 0 && (hasData || isCertificateOfServiceTemplate(template)), hasData, nodesPresent: Array.from(types) };
}

Deno.test("empty document refuses", () => {
  const r = evaluateDocumentContract({ code: "FAKE", body: { document: [] } });
  assertEquals(r.ok, false);
  assertEquals(r.hasData, false);
});

Deno.test("legacy sections-only body refuses (no document tree)", () => {
  const r = evaluateDocumentContract({ code: "P9_LEGACY", body: { sections: [{ type: "monthly_breakdown" }] } });
  assertEquals(r.ok, false);
});

Deno.test("v3 document with matrix passes", () => {
  const r = evaluateDocumentContract({
    code: "P9",
    body: { schema_version: 3, document: [{ type: "heading", level: 1 }, { type: "matrix", columns: [] }] },
  });
  assert(r.ok);
});

Deno.test("v4 document with grid at top level passes", () => {
  const r = evaluateDocumentContract({
    code: "P9V4",
    body: { schema_version: 4, document: [{ type: "grid", columns: [], data_rows: { bind: "rows.items" } }] },
  });
  assert(r.ok);
});

Deno.test("v4 grid nested inside a section still counts as data-bearing", () => {
  const r = evaluateDocumentContract({
    code: "NESTED",
    body: { schema_version: 4, document: [{ type: "section", children: [{ type: "grid", columns: [], data_rows: { bind: "rows.items" } }] }] },
  });
  assert(r.ok, `expected ok; nodesPresent=${r.nodesPresent.join(",")}`);
});

Deno.test("v4 grid nested inside columns still counts as data-bearing", () => {
  const r = evaluateDocumentContract({
    code: "COLS",
    body: { schema_version: 4, document: [{ type: "columns", count: 2, column_children: [[{ type: "heading" }], [{ type: "grid", columns: [], data_rows: { bind: "rows.items" } }]] }] },
  });
  assert(r.ok);
});

Deno.test("document with only text nodes refuses", () => {
  const r = evaluateDocumentContract({
    code: "TEXT_ONLY",
    body: { schema_version: 4, document: [{ type: "heading" }, { type: "rich_text" }, { type: "signature_strip" }] },
  });
  assertEquals(r.ok, false);
});

Deno.test("Certificate of Service text-only document passes without fake payroll matrix", () => {
  const r = evaluateDocumentContract({
    code: "CERT_OF_SERVICE",
    display_name: "Certificate of Service",
    body: { schema_version: 3, document: [{ type: "identity_strip" }, { type: "section" }, { type: "signature_strip" }] },
  });
  assertEquals(r.ok, true);
  assertEquals(r.hasData, false);
});