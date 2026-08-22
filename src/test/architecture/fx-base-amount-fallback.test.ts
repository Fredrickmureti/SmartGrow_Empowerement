/**
 * ADR 0136 ratchet — no client-side silent 1:1.
 *
 * A base-currency amount that is null means "no rate on file". Substituting the
 * foreign-denominated amount in its place invents a 1:1 rate and produces a
 * number no ledger can defend. The absence must travel to the UI intact.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

const ROOT = resolve(process.cwd(), "src/services/finance");

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const p = join(dir, entry);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });

// base_x_amount ?? something.x_amount  /  base_x_amount || Number(...)
const FALLBACK =
  /base_[a-z_]*amount\s*(\?\?|\|\|)\s*(?!null)(?!0\b)[A-Za-z_$][\w$.]*/g;

describe("ADR 0136 — no foreign-amount fallback for a missing base amount", () => {
  const files = walk(ROOT);

  it("scans the finance service layer", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files.map((f) => [f.replace(process.cwd() + "/", ""), f]))(
    "%s keeps absence as absence",
    (_label, file) => {
      const offenders = readFileSync(file, "utf8").match(FALLBACK) ?? [];
      expect(offenders, `silent 1:1 fallback: ${offenders.join(", ")}`).toHaveLength(0);
    },
  );
});
