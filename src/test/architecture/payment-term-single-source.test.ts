/**
 * Architecture guard — payment terms have exactly one resolver, no fallbacks.
 *
 * Invariants (see mem/features/payment-terms.md):
 *  1. Credit periods are NEVER hardcoded. A missing term means "due on receipt"
 *     (0 days), resolved server-side by `public.resolve_payment_term`
 *     (document override -> party default -> company default -> due on receipt).
 *  2. `businesses.default_payment_terms` is RETIRED and the column has been
 *     DROPPED from the database. It must never be reintroduced, read, written,
 *     or used as a fallback — reviving it recreates the "30 days" bug where the
 *     UI disagreed with Company Settings.
 *  3. Client code reaches the resolver only through
 *     `src/services/finance/paymentTerms.ts`.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep, posix } from "node:path";

const SCOPES = ["src/hooks", "src/components", "src/pages", "src/features", "src/services"];

const ALLOWLIST = new Set<string>(
  [
    // This file contains the forbidden identifiers as literals.
    "src/test/architecture/payment-term-single-source.test.ts",
  ].map((p) => p.split("/").join(sep)),
);

/** Retired column — dropped from the DB, must not reappear anywhere. */
const RETIRED_COLUMN = /\bdefault_payment_terms\b/;

/** Hardcoded credit period, e.g. addDays(x, 30) / setDate(d.getDate() + 30). */
const HARDCODED_CREDIT_PERIOD =
  /(addDays\s*\([^)]*,\s*(?:7|14|15|21|30|45|60|90)\s*\))|(getDate\(\)\s*\+\s*(?:7|14|15|21|30|45|60|90)\b)/;

function walk(dir: string): string[] {
  const out: string[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const toPosix = (p: string) => p.split(sep).join(posix.sep);

/** Only due-date arithmetic is in scope; quote validity / roster ranges are not. */
const DUE_DATE_CONTEXT = /due_date|dueDate|payment_term|paymentTerm/i;

function scan(pattern: RegExp, contextOnly = false): string[] {
  const offenders: string[] = [];
  for (const scope of SCOPES) {
    for (const f of walk(scope)) {
      if (ALLOWLIST.has(f)) continue;
      const lines = readFileSync(f, "utf8").split("\n");
      lines.forEach((ln, i) => {
        if (!pattern.test(ln)) return;
        if (contextOnly) {
          // Look at a small window so `const due = addDays(new Date(), 30)`
          // followed by `due_date: due` is still caught.
          const window = lines.slice(Math.max(0, i - 3), i + 4).join("\n");
          if (!DUE_DATE_CONTEXT.test(window)) return;
        }
        offenders.push(`${toPosix(f)}:${i + 1}`);
      });
    }
  }
  return offenders;
}

describe("architecture: payment terms single source of truth", () => {
  it("never references the retired businesses.default_payment_terms column", () => {
    const offenders = scan(RETIRED_COLUMN);
    expect(
      offenders,
      "`default_payment_terms` is retired and dropped from the database. Resolve terms via " +
        "src/services/finance/paymentTerms.ts (resolve_payment_term) instead.\n" +
        offenders.join("\n"),
    ).toEqual([]);
  });

  it("never hardcodes a credit period as a due-date fallback", () => {
    const offenders = scan(HARDCODED_CREDIT_PERIOD, true);
    expect(
      offenders,
      "Due dates must come from the resolved payment term; an unresolved term means due on " +
        "receipt (0 days), never a made-up net period.\n" + offenders.join("\n"),
    ).toEqual([]);
  });
});
