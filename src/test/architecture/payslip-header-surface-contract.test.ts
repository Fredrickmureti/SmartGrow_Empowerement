/**
 * Payslip header surface contract
 * --------------------------------
 * Every surface that renders the payslip "header" block (employer +
 * employee + statutory identifiers) MUST consume the country-agnostic
 * shared model — either by calling the `payslip_header` Postgres RPC
 * directly (edge functions) or by going through the React hook
 * `usePayslipHeader` from `@/lib/payroll/payslipHeader` (UI).
 *
 * This guard exists because the admin "Payslip Detail" page silently
 * drifted by re-implementing its own header against `v_payslips_redacted`
 * + raw `employees`, which dropped statutory identifiers (Tax PIN /
 * NSSF / SHIF / RSSB / etc) and broke localization-pack scalability.
 *
 * If you add a new payslip-rendering surface (PDF, portal page, admin
 * page, mobile view, exported document, …), add it here AND make sure
 * it consumes the shared header. Do NOT add bypasses.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface Surface {
  path: string;
  // Allowed contracts for this surface. At least one must match.
  contracts: Array<"usePayslipHeader" | "useSharedPayslipHeader" | "payslip_header-rpc" | "PayslipHeader-component">;
}

const SURFACES: Surface[] = [
  // UI — admin dialog
  {
    path: "src/components/payroll/PayslipDetailDialog.tsx",
    contracts: ["usePayslipHeader", "PayslipHeader-component"],
  },
  // UI — admin route-mounted detail page
  {
    path: "src/pages/hr/payroll/sections.tsx",
    contracts: ["useSharedPayslipHeader", "PayslipHeader-component"],
  },
  // Edge function — PDF
  {
    path: "supabase/functions/generate-payslip-pdf/index.ts",
    contracts: ["payslip_header-rpc"],
  },
];

const CHECKS: Record<Surface["contracts"][number], RegExp> = {
  // Named import of the shared React hook from the canonical module.
  usePayslipHeader: /import\s*{[^}]*\busePayslipHeader\b[^}]*}\s*from\s*["']@\/lib\/payroll\/payslipHeader["']/,
  // Same module, imported under the conventional alias used in sections.tsx
  // to avoid colliding with the legacy local function name.
  useSharedPayslipHeader:
    /import\s*{[^}]*\busePayslipHeader\s+as\s+useSharedPayslipHeader\b[^}]*}\s*from\s*["']@\/lib\/payroll\/payslipHeader["']/,
  // Server-side: must call the SECURITY-DEFINER RPC, not assemble its own header.
  "payslip_header-rpc": /\.rpc\(\s*["']payslip_header["']/,
  // Renderer component from the canonical module.
  "PayslipHeader-component":
    /import\s*{[^}]*\bPayslipHeader\b[^}]*}\s*from\s*["']@\/components\/payroll\/PayslipHeader["']/,
};

// Patterns that indicate a surface is rebuilding the header from raw
// tables — the exact failure mode this contract prevents.
const FORBIDDEN_RAW_TABLE_PATTERNS: RegExp[] = [
  // Direct reads of the per-row statutory identifier table from a
  // rendering surface — every rendering surface must read the RPC's
  // pre-shaped statutory_ids array. (Admin editor UIs, hooks, and
  // server functions are allowed by the SOURCE_ALLOWLIST below.)
  /\.from\(\s*["']employee_statutory_identifiers["']/,
  /\.from\(\s*["']organization_statutory_identifiers["']/,
];

// Files that are allowed to read the raw identifier tables (the
// editors, the security-definer RPC, and the per-employee hook).
const RAW_TABLE_ALLOWLIST = [
  /^src\/hooks\/employees\/useEmployeeStatutoryIdentifiers\.ts$/,
  /^src\/hooks\/organization\/useOrganizationStatutoryIdentifiers\.ts$/,
  /^src\/components\/payroll\/EmployerStatutoryIdentifiersCard\.tsx$/,
  /^src\/pages\/(?!hr\/payroll\/sections\.tsx).*$/,
];

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

describe("payslip header surface contract", () => {
  for (const surface of SURFACES) {
    it(`${surface.path} consumes the shared payslip header contract`, () => {
      const body = read(surface.path);
      const matched = surface.contracts.filter((c) => CHECKS[c].test(body));
      expect(
        matched,
        `${surface.path} must satisfy at least one of: ${surface.contracts.join(", ")}`,
      ).not.toEqual([]);
      // Every UI contract requires the renderer component too — keep all
      // surfaces visually identical.
      if (surface.contracts.includes("PayslipHeader-component")) {
        expect(matched).toContain("PayslipHeader-component");
      }
    });

    it(`${surface.path} does not rebuild the header from raw tables`, () => {
      // Allow-listed editors are still allowed to write to the raw
      // tables — they're not rendering surfaces.
      if (RAW_TABLE_ALLOWLIST.some((re) => re.test(surface.path))) return;
      const body = read(surface.path);
      for (const re of FORBIDDEN_RAW_TABLE_PATTERNS) {
        expect(
          body,
          `${surface.path} must read statutory IDs through the payslip_header RPC, not raw tables`,
        ).not.toMatch(re);
      }
    });
  }
});

describe("payslip header model — pack-declared labels win", () => {
  it("hydratePayslipHeader prefers pack.required[*].label over the local map", async () => {
    const { hydratePayslipHeader } = await import("@/lib/payroll/payslipHeader");
    const out = hydratePayslipHeader({
      employer: { organization_id: "o", name: "Acme", country_code: "RW", statutory_ids: [
        { identifier_type: "rssb_employer", identifier_value: "EMP-1", country_code: "RW" },
      ] },
      employee: { id: "e", name: "Alice", statutory_ids: [
        { identifier_type: "rssb", identifier_value: "RSSB-123", country_code: "RW" },
      ] },
      period: {},
      pack: {
        country_code: "RW",
        required: [
          { identifier_type: "rssb", label: "RSSB Number (Rwanda)", is_required: true },
          { identifier_type: "rssb_employer", label: "RSSB Employer No. (Rwanda)", is_required: true },
        ],
      },
      notes: [],
    });
    expect(out).not.toBeNull();
    expect(out!.employee.statutory_ids[0].label).toBe("RSSB Number (Rwanda)");
    expect(out!.employer.statutory_ids[0].label).toBe("RSSB Employer No. (Rwanda)");
  });

  it("falls back to the client humaniser when no pack label is present", async () => {
    const { hydratePayslipHeader } = await import("@/lib/payroll/payslipHeader");
    const out = hydratePayslipHeader({
      employer: { organization_id: "o", name: "Acme", country_code: null, statutory_ids: [] },
      employee: { id: "e", name: "Alice", statutory_ids: [
        // No pack.required entry — must humanise via labelForIdentifier.
        { identifier_type: "nssf", identifier_value: "NSSF-1", country_code: null },
      ] },
      period: {},
      pack: { country_code: null, required: [] },
      notes: [],
    });
    expect(out!.employee.statutory_ids[0].label).toMatch(/NSSF/);
  });
});
