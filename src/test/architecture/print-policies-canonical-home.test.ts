/**
 * Wave 9d Phase 4 — canonical home for print policies.
 *
 * The `document_print_policies` editor (`<PrintingSettings />`) and the
 * `PrinterProfilesCard` surface must live under `/platform/hardware/*`
 * and NOT be re-mounted inside `Settings → Company` or any other
 * non-hardware shell. `Settings → Company → Printing` is a redirect
 * stub only; Phase 6 deletes it entirely.
 *
 * If you are intentionally relocating either surface, update the
 * allow-list below in the same commit.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";

const ROOT = resolve(__dirname, "../../..");

function grep(pattern: string): string[] {
  try {
    const out = execSync(
      `rg -l --no-messages -e ${JSON.stringify(pattern)} src/`,
      { cwd: ROOT, encoding: "utf-8" },
    );
    return out.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

describe("Print policies canonical home (Wave 9d Phase 4)", () => {
  it("<PrintingSettings /> is only rendered under /apps/platform/hardware/", () => {
    // Importers/renderers of PrintingSettings.
    const files = grep("PrintingSettings").filter(
      (f) => !f.endsWith("PrintingSettings.tsx") &&
             !f.includes("/test/") &&
             !f.startsWith("src/components/settings/"),
    );
    const allowed = new Set([
      "src/apps/platform/hardware/HardwarePolicies.tsx",
    ]);
    const stray = files.filter((f) => !allowed.has(f));
    expect(stray, `Unexpected PrintingSettings importer(s): ${stray.join(", ")}`)
      .toEqual([]);
  });

  it("PrinterProfilesCard is only imported inside the hardware surface", () => {
    const files = grep("PrinterProfilesCard").filter(
      (f) => !f.endsWith("PrinterProfilesCard.tsx") &&
             !f.includes("/test/") &&
             !f.includes("/hooks/usePrinterProfiles.ts"),
    );
    // PrintingSettings hosts the card and is itself gated by the
    // previous test to only render under /platform/hardware/.
    const allowed = new Set([
      "src/components/settings/PrintingSettings.tsx",
    ]);
    const stray = files.filter((f) => !allowed.has(f));
    expect(stray, `Unexpected PrinterProfilesCard importer(s): ${stray.join(", ")}`)
      .toEqual([]);
  });

  it("Settings → Company printing tab is a redirect stub, not an editor", () => {
    const src = readFileSync(
      resolve(ROOT, "src/pages/settings/CompanySettings.tsx"),
      "utf-8",
    );
    // Redirect link to the canonical home must be present.
    expect(src).toContain("/platform/hardware/policies");
    // And the tab must NOT mount <PrintingSettings /> anymore.
    expect(src).not.toMatch(/<PrintingSettings\b/);
  });

  it("WorkflowBindingsCard is only imported inside the hardware surface", () => {
    const files = grep("WorkflowBindingsCard").filter(
      (f) => !f.endsWith("WorkflowBindingsCard.tsx") &&
             !f.includes("/test/") &&
             !f.includes("/hooks/usePrinterProfiles.ts"),
    );
    const stray = files.filter((f) => !f.startsWith("src/apps/platform/hardware/"));
    expect(stray, `Unexpected WorkflowBindingsCard importer(s): ${stray.join(", ")}`)
      .toEqual([]);
  });
});
