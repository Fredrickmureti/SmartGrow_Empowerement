/**
 * Certificate engine — browser ↔ edge mirror parity.
 *
 * The country-agnostic renderer lives in TWO physical modules:
 *
 *   src/features/localization/lib/engine/compile.ts   (browser preview)
 *   supabase/functions/_shared/certificate-engine/    (edge PDF pipeline)
 *
 * "What a publisher sees is what a tenant files" only holds if these two
 * compile the same AST to the same HTML+CSS. This test drives both
 * modules with the shared country-agnostic fixture and asserts byte
 * parity. Any drift — a header nocheck aside — must be intentional and
 * reflected on both sides in the same PR.
 *
 * Trivial known differences that are NOT logical drift:
 *   - edge file has a leading `// @ts-nocheck — Deno runtime` comment
 *   - edge imports use explicit `.ts` extensions (Deno requires them)
 * Both are stripped from the compiled *output* HTML (they only affect
 * the source), so this test compares emitted HTML/CSS directly.
 */
import { describe, it, expect } from "vitest";
import { compile as compileBrowser } from "../../features/localization/lib/engine/compile";
// The edge module is authored for Deno but is plain TypeScript — vitest
// resolves the `./types.ts` / `./resolver.ts` imports because the tsconfig
// paths handle explicit extensions in ESM.
import { compile as compileEdge } from "../../../supabase/functions/_shared/certificate-engine/compile";
import { GENERIC_EXAMPLE_TEMPLATE } from "../../features/localization/lib/engine/templates/genericExample";

const PAYLOAD = {
  employer: { name: "Acme Ltd", tax_id: "P0000000A" },
  employee: { full_name: "Jane Doe", national_id: "12345678" },
  rows: {
    items: [
      { month: "Jan", gross: 100000, tax: 15000, net: 85000 },
      { month: "Feb", gross: 110000, tax: 16500, net: 93500 },
      { month: "Mar", gross: 105000, tax: 15750, net: 89250 },
    ],
  },
};

describe("certificate engine — browser ↔ edge parity", () => {
  it("produces byte-identical HTML for the shared fixture", () => {
    const b = compileBrowser(GENERIC_EXAMPLE_TEMPLATE as any, PAYLOAD as any, { currency: "KES" });
    const e = compileEdge(GENERIC_EXAMPLE_TEMPLATE as any, PAYLOAD as any, { currency: "KES" });
    expect(e.html).toBe(b.html);
  });

  it("produces byte-identical CSS for the shared fixture", () => {
    const b = compileBrowser(GENERIC_EXAMPLE_TEMPLATE as any, PAYLOAD as any, { currency: "KES" });
    const e = compileEdge(GENERIC_EXAMPLE_TEMPLATE as any, PAYLOAD as any, { currency: "KES" });
    expect(e.css).toBe(b.css);
  });

  it("agrees on unresolved bindings", () => {
    const b = compileBrowser(GENERIC_EXAMPLE_TEMPLATE as any, {} as any, { currency: "KES" });
    const e = compileEdge(GENERIC_EXAMPLE_TEMPLATE as any, {} as any, { currency: "KES" });
    expect([...e.unresolved].sort()).toEqual([...b.unresolved].sort());
  });
});