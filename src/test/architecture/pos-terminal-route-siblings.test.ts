/**
 * Architecture guard — the six phase-driven sibling routes under
 * `/pos/terminal/:registerId` must NOT all resolve to the same element.
 *
 * Slice C.2 of the workstation-decomposition plan: as workspaces move
 * out of the `POSTerminal` monolith into route-owned components
 * (`ReceiptRoute`, later `SaleWorkspace`, `TenderRoute`, ...), it is a
 * silent regression to point a sibling back at `<POSTerminal />`.
 *
 * This test statically parses `src/apps/pos/routes.tsx`, extracts every
 * `<Route path="<segment>" element={<X />} />` under the terminal shell,
 * and asserts that the receipt sibling has already been swapped away
 * from `POSTerminal` — plus that any future extraction is enforced by
 * updating this test's expectations, not by silently reverting.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = resolve(__dirname, "../../apps/pos/routes.tsx");
const PHASE_SEGMENTS = ["sale", "tender", "receipt", "return", "held", "history"] as const;

function elementFor(code: string, segment: string): string | null {
  const re = new RegExp(
    `<Route\\s+path=\\"${segment}\\"\\s+element=\\{<([A-Za-z0-9_]+)\\s*/?>\\}\\s*/>`,
  );
  const m = code.match(re);
  return m ? m[1] : null;
}

describe("POS terminal sibling routes", () => {
  const code = readFileSync(SRC, "utf8");

  it("every phase sibling has a declared element", () => {
    for (const seg of PHASE_SEGMENTS) {
      expect(elementFor(code, seg), `missing <Route path="${seg}">`).toBeTruthy();
    }
  });

  it("receipt is a route-owned surface, not the POSTerminal monolith", () => {
    expect(elementFor(code, "receipt")).toBe("ReceiptRoute");
  });

  it("no two phase siblings share the same element unless it is the transitional POSTerminal shim", () => {
    const counts = new Map<string, string[]>();
    for (const seg of PHASE_SEGMENTS) {
      const el = elementFor(code, seg) ?? "<missing>";
      const list = counts.get(el) ?? [];
      list.push(seg);
      counts.set(el, list);
    }
    for (const [element, segments] of counts) {
      if (element === "POSTerminal") continue; // transitional shim
      expect(
        segments.length,
        `element ${element} is shared by siblings ${segments.join(", ")}`,
      ).toBe(1);
    }
  });
});
