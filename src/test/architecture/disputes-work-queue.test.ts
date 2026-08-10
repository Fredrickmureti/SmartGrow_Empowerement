/**
 * Architecture guard: disputes and the collections work queue are operational
 * overlays on canonical AR.
 *
 *  - a dispute never reduces the receivable; it is reported separately and
 *    puts dunning on hold.
 *  - the queue's exposure, ranking and de-prioritisation are computed in SQL
 *    over `finance_ar_net_position` — the browser never re-derives them.
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

describe("disputes and work queue architecture", () => {
  const sql = allMigrations();

  it("creates ar_disputes with grants, RLS and org scoping", () => {
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS public.ar_disputes");
    expect(sql).toContain(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON public.ar_disputes TO authenticated",
    );
    expect(sql).toContain("GRANT ALL ON public.ar_disputes TO service_role");
    expect(sql).toContain("ALTER TABLE public.ar_disputes ENABLE ROW LEVEL SECURITY");
  });

  it("writes disputes only through the RPCs, with a deterministic request key", () => {
    const svc = read("src/services/finance/disputes.ts");
    expect(svc).toContain("raise_ar_dispute");
    expect(svc).toContain("resolve_ar_dispute");
    expect(svc).toContain("disputeRequestKey");
    expect(svc).not.toMatch(/crypto\.randomUUID\(/);
    expect(svc).not.toMatch(/from\("ar_disputes"[\s\S]{0,120}\.(insert|update|delete)/);
  });

  it("never writes back to invoices or the ledger from a dispute", () => {
    const idx = sql.indexOf("FUNCTION public.raise_ar_dispute");
    expect(idx).toBeGreaterThan(-1);
    const body = sql.slice(idx, idx + 3000);
    expect(body).not.toMatch(/update\s+public\.invoices/i);
    expect(body).not.toMatch(/insert\s+into\s+public\.journal_entr/i);
  });

  it("suppresses dunning escalation while a dispute is open", () => {
    const idx = sql.lastIndexOf("VIEW public.dunning_assignment");
    expect(idx).toBeGreaterThan(-1);
    const body = sql.slice(idx, idx + 3000);
    expect(body).toContain("public.ar_disputes");
    expect(body).toContain("on_hold");
  });

  it("scores the work queue in SQL over the canonical net position", () => {
    const idx = sql.indexOf("VIEW public.collections_work_queue");
    expect(idx).toBeGreaterThan(-1);
    const body = sql.slice(idx, idx + 4000);
    expect(body).toContain("public.finance_ar_net_position");
    expect(body).toContain("priority_score");
    // Overlays de-prioritise, they do not remove rows from the queue.
    expect(body).toContain("in_dispute");
    expect(body).toContain("in_promise");
    expect(body).not.toMatch(/from\s+public\.invoices/i);
  });

  it("the client reads the queue from the RPC and does not re-rank it", () => {
    const svc = read("src/services/finance/collectionsWorkQueue.ts");
    expect(svc).toContain("get_collections_work_queue");
    expect(svc).not.toMatch(/\.sort\(/);
    expect(svc).not.toMatch(/priorityScore\s*=\s*[^;]*[*+]/);
  });

  it("the UI surfaces disputes and the work queue", () => {
    const page = read("src/pages/sales/Collections.tsx");
    expect(page).toContain("useArDisputes");
    expect(page).toContain("useCollectionsWorkQueue");
    expect(page).toContain("RaiseDisputeDialog");
  });
});
