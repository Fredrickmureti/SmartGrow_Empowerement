/**
 * Architecture guard — ADR-0093 (Legal Recipient Master Data).
 *
 * Retired columns on `legal_orders_records` (per ADR-0093):
 *   - authority_contact_id / recipient_contact_id  (overlay FK)
 *   - payee_name / payee_bank / payee_account / payee_reference
 *     (free-text snapshot)
 *
 * The canonical writers per ADR-0093 are `authority_id`
 * (→ legal_order_authorities) and `recipient_id` (→ legal_recipients).
 * Recipient identity, bank details, and remittance reference template
 * live on the recipient master. Client code must never write the
 * retired columns again. The auto-generated Supabase `types.ts` still
 * lists them until the physical DROP migration lands (Phase R4b).
 *
 * This guard scans writer-shaped source (`src/pages/**`, `src/components/**`,
 * `src/features/**`) and fails if any file assigns these columns as
 * object keys. Read-side fallbacks (property access like `.payee_name`)
 * remain acceptable until the physical drop.
 */
import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";

const FORBIDDEN_ANY = ["authority_contact_id", "recipient_contact_id"];
// These four are struct-shape only: assignment as an object key is a write.
// Property reads (`.payee_name`) are allowed until the DB drop lands.
const FORBIDDEN_WRITES = [
  "payee_name",
  "payee_bank",
  "payee_account",
  "payee_reference",
];

function scan(pattern: string, scope: string): string[] {
  try {
    const out = execSync(
      `rg -n --no-heading '${pattern}' ${scope} -g '!src/integrations/supabase/types.ts' -g '!src/__tests__/architecture.legal-orders-overlay-columns.test.ts'`,
      { encoding: "utf8" },
    );
    return out
      .split("\n")
      .filter(Boolean)
      // Documentation lines about why we do NOT write these are acceptable.
      .filter((line) => !/NOTE:|ADR-0093|retired|Phase R4/i.test(line));
  } catch {
    return [];
  }
}

describe("Legal orders overlay columns (ADR-0093)", () => {
  for (const token of FORBIDDEN_ANY) {
    it(`is not referenced from client code: ${token}`, () => {
      const hits = scan(token, "src");
      expect(
        hits,
        `Client code must not reference retired overlay column "${token}". Use authority_id / recipient_id per ADR-0093.\n${hits.join("\n")}`,
      ).toEqual([]);
    });
  }

  for (const key of FORBIDDEN_WRITES) {
    it(`is not written as an object key from writer code: ${key}`, () => {
      // Match `<key>:` in writer-shaped source (excludes hooks/types where
      // Row shapes legitimately declare the field as a type property).
      const hits = scan(
        `\\b${key}\\s*:`,
        "src/pages src/components src/features",
      );
      expect(
        hits,
        `Retired payee snapshot column "${key}" must not be written from UI code. Recipient bank/name/reference live on legal_recipients (ADR-0093).\n${hits.join("\n")}`,
      ).toEqual([]);
    });
  }
});
