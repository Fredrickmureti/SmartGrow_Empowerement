/**
 * Cash Flow has ONE engine.
 *
 * `public.finance_cash_flow_statement` computes the statement. The screen
 * (`src/services/finance/cashFlow.ts` → hook → page) and the export path
 * (`supabase/functions/_shared/reportDataEngine.ts#buildCashFlow` behind
 * `render-report`) are both renderers of that payload.
 *
 * The defect this guard exists to prevent: the export path once carried its
 * own heuristic — net income plus a working-capital lump, with cash accounts
 * identified by matching "cash"/"bank" inside the account NAME, and no
 * investing, financing, FX or opening/closing cash. The archived PDF then
 * stated a different cash flow from the screen it was exported from.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

const ENGINE = read("supabase/functions/_shared/reportDataEngine.ts");
const SERVICE = read("src/services/finance/cashFlow.ts");
const HOOK = read("src/hooks/useCashFlowReport.ts");

/** `buildCashFlow` body, from its declaration to the next exported function. */
function cashFlowBuilder(): string {
  const start = ENGINE.indexOf("export async function buildCashFlow");
  expect(start, "buildCashFlow is missing from the report data engine").toBeGreaterThan(-1);
  const next = ENGINE.indexOf("export async function", start + 10);
  return ENGINE.slice(start, next === -1 ? ENGINE.length : next);
}

describe("cash flow — one engine, two renderers", () => {
  it("builds the exported statement from the server engine", () => {
    expect(cashFlowBuilder()).toContain("finance_cash_flow_statement");
  });

  it("never guesses what a cash account is from its name", () => {
    const body = cashFlowBuilder();
    expect(body).not.toMatch(/includes\(\s*["'](cash|bank)["']\s*\)/i);
    expect(body).not.toMatch(/toLowerCase\(\)\s*\.\s*includes/);
  });

  it("does not re-derive account classification in the export path", () => {
    const body = cashFlowBuilder();
    // No account-type partitioning, no balance arithmetic over accounts.
    expect(body).not.toContain("account_type");
    expect(body).not.toContain("closing_balance");
    expect(body).not.toContain("getGLAccountBalances");
  });

  it("presents the IAS 7 anchors the engine returns", () => {
    const body = cashFlowBuilder();
    for (const key of ["opening_cash", "closing_cash", "fx_effect", "net_cash_flow", "reconciliation"]) {
      expect(body, `${key} must reach the export`).toContain(key);
    }
  });

  it("keeps the browser a consumer: the service is the only RPC caller", () => {
    expect(SERVICE).toContain("finance_cash_flow_statement");
    expect(HOOK).not.toContain("finance_cash_flow_statement\"");
  });

  it("keeps accounting arithmetic out of the hook", () => {
    // No section building, no working-capital math, no closing-cash assignment.
    expect(HOOK).not.toMatch(/openingCash\s*\+\s*net/);
    expect(HOOK).not.toMatch(/Math\.abs\([^)]*depreciation/i);
    expect(HOOK).not.toContain("cash_flow_category");
  });
});
