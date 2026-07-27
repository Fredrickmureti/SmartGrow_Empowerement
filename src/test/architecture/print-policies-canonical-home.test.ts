/**
 * Wave 9d Phase 4 (+ Phase 6 Step C) — canonical home for print policies.
 *
 * The `document_print_policies` editor is `<PrintPoliciesEditor />` and
 * lives under `/platform/hardware/*`. `Settings → Company → Printing`
 * has been deleted entirely, and the legacy
 * `@/components/settings/PrintingSettings` module no longer exists.
 * `WorkflowBindingsCard` and `resolve_device_for_workflow` were retired
 * with `printer_workflow_bindings` — the only routing seam is
 * `document_print_policies` + `resolve_device`.
 *
 * If you are intentionally relocating the editor, update the allow-list
 * below in the same commit.
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

describe("Print policies canonical home (Phase 6 Step C)", () => {
  it("<PrintPoliciesEditor /> is only rendered under /apps/platform/hardware/", () => {
    const files = grep("from ['\"]@/apps/platform/hardware/PrintPoliciesEditor").filter(
      (f) => !f.endsWith("PrintPoliciesEditor.tsx") && !f.includes("/test/"),
    );
    const allowed = new Set([
      "src/apps/platform/hardware/HardwarePolicies.tsx",
    ]);
    const stray = files.filter((f) => !allowed.has(f));
    expect(stray, `Unexpected PrintPoliciesEditor importer(s): ${stray.join(", ")}`)
      .toEqual([]);
  });

  it("legacy '@/components/settings/PrintingSettings' module is gone", () => {
    const importers = grep("from ['\"]@/components/settings/PrintingSettings");
    expect(importers, `Legacy PrintingSettings importer(s): ${importers.join(", ")}`)
      .toEqual([]);
  });

  it("Settings → Company no longer ships a printing tab", () => {
    const src = readFileSync(
      resolve(ROOT, "src/pages/settings/CompanySettings.tsx"),
      "utf-8",
    );
    expect(src).not.toMatch(/value=["']printing["']/);
    expect(src).not.toMatch(/<PrintingSettings\b/);
  });

  it("WorkflowBindingsCard has been fully removed", () => {
    const files = grep("WorkflowBindingsCard").filter((f) => !f.includes("/test/"));
    expect(files, `Stale WorkflowBindingsCard reference(s): ${files.join(", ")}`)
      .toEqual([]);
  });

  it("resolve_device_for_workflow RPC has no live callers", () => {
    // types.ts is regenerated from Supabase and may briefly list a
    // dropped RPC until the next codegen run.
    const files = grep("resolve_device_for_workflow").filter(
      (f) => !f.includes("/test/") && f !== "src/integrations/supabase/types.ts",
    );
    expect(files, `Stale resolve_device_for_workflow caller(s): ${files.join(", ")}`)
      .toEqual([]);
  });
});
