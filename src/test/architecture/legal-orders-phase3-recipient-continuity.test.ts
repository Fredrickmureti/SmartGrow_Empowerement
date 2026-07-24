/**
 * ADR-0093 Phase 3 — Recipient-centred financial continuity is wired.
 *
 * The database exposes an outstanding-balance rollup and a per-recipient
 * statement RPC; the frontend surfaces both. Removing either seam or
 * dropping the route makes this test fail so the invariant survives future
 * refactors.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const repo = process.cwd();
const read = (p: string) => readFileSync(join(repo, p), "utf8");

describe("Legal Orders — Phase 3 recipient financial continuity", () => {
  it("ships the recipient outstanding view + statement RPC migration", () => {
    // Latest phase-3 migration lives under supabase/migrations/*.
    // We assert by searching all migrations for the canonical definitions.
    const fs = require("node:fs") as typeof import("node:fs");
    const dir = "supabase/migrations";
    const files = fs.readdirSync(join(repo, dir)).filter((f) => f.endsWith(".sql"));
    const hay = files.map((f) => read(`${dir}/${f}`)).join("\n");
    expect(hay).toMatch(/CREATE\s+OR\s+REPLACE\s+VIEW\s+public\.legal_recipient_outstanding/);
    expect(hay).toMatch(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.legal_recipient_statement/);
  });

  it("exposes React Query hooks for outstanding + statement", () => {
    const src = read("src/hooks/useLegalRecipients.ts");
    expect(src).toMatch(/useLegalRecipientOutstanding/);
    expect(src).toMatch(/useLegalRecipientStatement/);
    expect(src).toMatch(/legal_recipient_outstanding/);
    expect(src).toMatch(/legal_recipient_statement/);
  });

  it("registers the Legal Recipients admin route", () => {
    expect(existsSync(join(repo, "src/pages/hr/payroll/LegalRecipients.tsx"))).toBe(true);
    const routes = read("src/apps/hr/sub/PayrollRoutes.tsx");
    expect(routes).toMatch(/legal-orders\/recipients/);
    expect(routes).toMatch(/LegalRecipients/);
  });
});
