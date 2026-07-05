/**
 * Architecture guard — every installed statutory return template MUST
 * declare a `body.filters.payslip_status` that matches its legal basis.
 *
 * Payroll Approval is the statutory document unlock event. Return generation
 * reads finalized payroll results/liabilities; employee payment and authority
 * settlement are separate downstream workflows. Therefore every structured
 * return template that declares `body.filters.payslip_status` MUST include
 * `"approved"` so new tenants cannot inherit a paid-only generation gate.
 */
import { describe, it, expect } from "vitest";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

describe("return template payslip_status matches legal basis", () => {
  const canRun = !!SUPABASE_URL && !!SUPABASE_KEY;
  (canRun ? it : it.skip)("structured templates include approved payslips", async () => {
    const client = createClient(SUPABASE_URL!, SUPABASE_KEY!);
    const { data, error } = await client
      .from("localization_pack_return_templates")
      .select("code, body");
    expect(error).toBeNull();

    const violations: string[] = [];
    for (const row of data ?? []) {
      const code = (row as any).code as string;
      const statuses: unknown = (row as any).body?.filters?.payslip_status;
      const list = Array.isArray(statuses) ? statuses.map((s) => String(s)) : [];

      if (list.length === 0) {
        violations.push(`${code}: filters.payslip_status is empty; structured statutory returns must explicitly include approved payroll results`);
        continue;
      }
      if (!list.includes("approved")) {
        violations.push(`${code}: statutory return templates must include "approved" (got ${JSON.stringify(list)})`);
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });
});
