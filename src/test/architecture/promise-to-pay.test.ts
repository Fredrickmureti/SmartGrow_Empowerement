/**
 * Architecture guard: Promise to Pay is a commitment overlay, never a second
 * source of receivable truth.
 *
 *  - promises live in their own org-scoped, RLS-enabled table with GRANTs.
 *  - writes go through `record_promise_to_pay` (server-resolved org, base
 *    currency, and an idempotency key derived from the promise intent).
 *  - kept/broken is decided by `evaluate_promise_status` against
 *    `finance_ar_net_position` — not by the browser, not from invoice status.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

function allMigrations(): string {
  const dir = resolve(process.cwd(), "supabase/migrations");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(resolve(dir, f), "utf8"))
    .join("\n\n");
}

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

describe("promise to pay architecture", () => {
  const sql = allMigrations();

  it("creates ar_promises_to_pay with grants, RLS and org scoping", () => {
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS public.ar_promises_to_pay");
    expect(sql).toContain("GRANT SELECT, INSERT, UPDATE, DELETE ON public.ar_promises_to_pay TO authenticated");
    expect(sql).toContain("GRANT ALL ON public.ar_promises_to_pay TO service_role");
    expect(sql).toContain("ALTER TABLE public.ar_promises_to_pay ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("is_org_member(auth.uid(), organization_id)");
  });

  it("enforces one promise per intent via a request-key unique index", () => {
    expect(sql).toContain("ar_promises_to_pay_request_key");
    expect(sql).toContain("client_request_id IS NOT NULL");
  });

  it("stores a base-currency value and the baseline residual", () => {
    expect(sql).toContain("base_promised_amount");
    expect(sql).toContain("baseline_residual");
  });

  it("resolves status from the canonical net position", () => {
    const idx = sql.indexOf("FUNCTION public.evaluate_promise_status");
    expect(idx).toBeGreaterThan(-1);
    const body = sql.slice(idx, idx + 2500);
    expect(body).toContain("public.finance_ar_net_position");
    expect(body).not.toMatch(/from\s+public\.invoices/i);
  });

  it("writes only through the RPC and derives a deterministic request key", () => {
    const svc = read("src/services/finance/promises.ts");
    expect(svc).toContain("record_promise_to_pay");
    expect(svc).toContain("promiseRequestKey");
    expect(svc).not.toContain("crypto.randomUUID");
    // No client-side insert into the promises table.
    expect(svc).not.toMatch(/from\("ar_promises_to_pay"[\s\S]{0,80}\.insert/);
  });

  it("the UI reads promises from the hook, not from invoices", () => {
    const page = read("src/pages/sales/Collections.tsx");
    expect(page).toContain("usePromisesToPay");
    expect(page).toContain("PromiseToPayDialog");
  });
});
