/**
 * Architecture guard — every installed statutory return template MUST
 * declare a `body.filters.payslip_status` that matches its legal basis.
 *
 *   - Accrual-basis returns (PAYE / income tax / statutory levies) MUST
 *     include `"approved"` so approving payroll is sufficient to file.
 *     Requiring payment for a liability-based return misrepresents when
 *     the tax point crystallises and is a common source of "why can't I
 *     file yet?" incidents in real payroll deployments.
 *
 *   - Cash-basis remittances (NSSF, SHIF, HELB, and analogous social
 *     contributions in other jurisdictions) MUST require `"paid"` and
 *     MUST NOT accept `"approved"` — the return reconciles cash outflow.
 *
 * The classification is code-prefix based rather than country-hardcoded so
 * new packs pick up the rule automatically. A template that does not match
 * any known family is required to declare a non-empty payslip_status filter,
 * forcing the pack author to make an explicit choice.
 */
import { describe, it, expect } from "vitest";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

const ACCRUAL_CODE_PATTERNS = [/^P10/, /^AHL/, /^NITA/, /^PAYE/, /^SDL/, /^ITAX/];
const CASH_CODE_PATTERNS = [/^NSSF/, /^SHIF/, /^NHIF/, /^HELB/];

function classify(code: string): "accrual" | "cash" | "unknown" {
  if (ACCRUAL_CODE_PATTERNS.some((r) => r.test(code))) return "accrual";
  if (CASH_CODE_PATTERNS.some((r) => r.test(code))) return "cash";
  return "unknown";
}

describe("return template payslip_status matches legal basis", () => {
  const canRun = !!SUPABASE_URL && !!SUPABASE_KEY;
  (canRun ? it : it.skip)("every template has a filter consistent with its family", async () => {
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
      const family = classify(code);

      if (list.length === 0) {
        violations.push(`${code}: filters.payslip_status is empty; declare the legal basis explicitly`);
        continue;
      }
      if (family === "accrual" && !list.includes("approved")) {
        violations.push(`${code}: accrual-basis template must include "approved" (got ${JSON.stringify(list)})`);
      }
      if (family === "cash") {
        if (!list.includes("paid")) {
          violations.push(`${code}: cash-basis template must include "paid" (got ${JSON.stringify(list)})`);
        }
        if (list.includes("approved")) {
          violations.push(`${code}: cash-basis template must NOT include "approved" (got ${JSON.stringify(list)})`);
        }
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });
});
