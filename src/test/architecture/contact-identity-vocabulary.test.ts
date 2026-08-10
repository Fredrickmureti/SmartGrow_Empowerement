import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * ADR 0029 / ADR 0031 — contact identity vocabulary.
 *
 * `contacts` has no `contact_type` column: `contact_type` is the NAME OF THE
 * ENUM behind the `type` column. Referencing it as a column crashes PostgREST
 * (`column contacts.contact_type does not exist`); referencing it as a JS
 * property silently yields `undefined`, emptying customer pickers with no
 * error. Customer selection must go through
 * `src/services/finance/customerIdentity.ts`.
 */

const SRC = path.resolve(__dirname, "../..");

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      walk(full, acc);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

// Legitimate mentions: the generated DB types (enum name), the import-alias
// list, and the identity module / this test which document the trap.
const ALLOWED = [
  "integrations/supabase/types.ts",
  "lib/contactImportConfig.ts",
  "services/finance/customerIdentity.ts",
  "test/architecture/contact-identity-vocabulary.test.ts",
];

describe("contact identity vocabulary", () => {
  const files = walk(SRC).filter(
    (f) => !ALLOWED.some((a) => f.replace(/\\/g, "/").endsWith(a)),
  );

  it("never reads contact_type as a column or property", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const src = fs.readFileSync(file, "utf8");
      // `.contact_type`, "contact_type" in a select/filter, c.contact_type ===
      if (/(\.contact_type\b)|(["'`]contact_type["'`]\s*,)|(\bin\(\s*["'`]contact_type)/.test(src)) {
        offenders.push(path.relative(SRC, file));
      }
    }
    expect(
      offenders,
      `contacts.contact_type does not exist — use CUSTOMER_IDENTITY_OR_FILTER / isCustomerContact from services/finance/customerIdentity.ts:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("exposes a single customer-identity predicate", () => {
    const src = fs.readFileSync(
      path.join(SRC, "services/finance/customerIdentity.ts"),
      "utf8",
    );
    expect(src).toMatch(/type\.in\.\(customer,both\),customer_rank\.gt\.0/);
    expect(src).toMatch(/export function isCustomerContact/);
  });

  it("keeps exactly one AR balance formula in useCustomerOutstandingBalance", () => {
    const src = fs.readFileSync(
      path.join(SRC, "hooks/useCustomerOutstandingBalance.ts"),
      "utf8",
    );
    // No per-doc_type switch: reversals and manual journals must be counted.
    expect(src).not.toMatch(/case\s+["']deposit["']/);
    expect(src).not.toMatch(/switch\s*\(\s*row\.doc_type/);
    expect(src).toMatch(/Number\(row\.debit\)\s*\|\|\s*0\)\s*-\s*\(Number\(row\.credit\)/);
  });
});
