/**
 * Architecture guard — Hardware Operator Workspace (ADR-0100).
 *
 * Enforces that the operator-facing Print activity and Diagnostics
 * surfaces present business identity, not raw enums or UUIDs, in their
 * primary tables. Enums must be rendered through humanize.ts;
 * technical identifiers may only appear inside the row drawer or under
 * the explicit "Support engineer view" toggle.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

describe("Hardware operator workspace — humanized presentation", () => {
  const printQueue = read("apps/platform/hardware/HardwarePrintQueue.tsx");
  const diagnostics = read("apps/platform/hardware/HardwareDiagnostics.tsx");
  const humanize = read("apps/platform/hardware/lib/humanize.ts");

  it("humanize.ts exports the canonical presentation helpers", () => {
    for (const sym of [
      "docTypeLabel",
      "intentLabel",
      "formatLabel",
      "transportLabel",
      "statusLabel",
      "runtimeReasonLabel",
      "classifyError",
    ]) {
      expect(humanize, `humanize.ts must export ${sym}`).toMatch(
        new RegExp(`export function ${sym}\\b`),
      );
    }
  });

  it("HardwarePrintQueue renders enums through humanize helpers and resolves business identity", () => {
    expect(printQueue).toMatch(/from ["']\.\/lib\/humanize["']/);
    expect(printQueue).toMatch(/statusLabel\(/);
    expect(printQueue).toMatch(/transportLabel\(/);
    expect(printQueue).toMatch(/intentLabel\(/);
    expect(printQueue).toMatch(/useDocumentDisplay/);
    expect(printQueue).toMatch(/useRequesterDisplay/);
    expect(printQueue).toMatch(/usePrinterDisplay/);
    expect(printQueue).toMatch(/JobDetailDrawer/);
  });

  it("HardwarePrintQueue does not render raw doc_type / intent / transport as leaf JSX text", () => {
    const forbidden = [
      />\s*\{r\.doc_type\}\s*</,
      />\s*\{r\.intent\}\s*</,
      />\s*\{r\.format\}\s*</,
      />\s*\{r\.transport\}\s*</,
      />\s*\{r\.status\}\s*</,
    ];
    for (const re of forbidden) {
      expect(printQueue, `raw enum leaf text matched ${re}`).not.toMatch(re);
    }
  });

  it("HardwareDiagnostics is a tabbed workspace, not one linear scroll", () => {
    expect(diagnostics).toMatch(/from ["']@\/components\/ui\/tabs["']/);
    expect(diagnostics).toMatch(/<Tabs\b/);
    for (const val of ["overview", "devices", "activity", "errors", "runtime", "support"]) {
      expect(diagnostics, `missing tab value=${val}`).toMatch(
        new RegExp(`value=["']${val}["']`),
      );
    }
  });

  it("HardwareDiagnostics uses runtimeReasonLabel from humanize, not an inline label map", () => {
    expect(diagnostics).toMatch(/runtimeReasonLabel/);
    expect(diagnostics).not.toMatch(/RUNTIME_REASON_LABELS\s*:\s*Record<RuntimeReason/);
  });
});