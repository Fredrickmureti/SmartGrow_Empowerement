/**
 * Architecture guard — ADR-0093 (Legal Recipient Master Data).
 *
 * `legal_orders_records.authority_contact_id` and
 * `legal_orders_records.recipient_contact_id` are the retired
 * "fourth-party overlay" columns. The canonical writers per ADR-0093
 * are `authority_id` (→ legal_order_authorities) and `recipient_id`
 * (→ legal_recipients). Client code must never write the overlay
 * columns again — the auto-generated Supabase `types.ts` still lists
 * them until the physical drop lands in a later phase.
 *
 * This guard scans `src/` (excluding the generated types file) and
 * fails if any source file writes these columns.
 */
import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";

const FORBIDDEN = ["authority_contact_id", "recipient_contact_id"];

function scan(token: string): string[] {
  try {
    const out = execSync(
      `rg -n --no-heading "${token}" src -g '!src/integrations/supabase/types.ts' -g '!src/__tests__/architecture.legal-orders-overlay-columns.test.ts'`,
      { encoding: "utf8" },
    );
    return out
      .split("\n")
      .filter(Boolean)
      // A brief NOTE explaining why we do NOT write it is acceptable.
      .filter((line) => !/NOTE:|ADR-0093|retired/i.test(line));
  } catch {
    return [];
  }
}

describe("Legal orders overlay columns (ADR-0093)", () => {
  for (const token of FORBIDDEN) {
    it(`is not written from client code: ${token}`, () => {
      const hits = scan(token);
      expect(
        hits,
        `Client code must not reference retired overlay column "${token}". Use authority_id / recipient_id per ADR-0093.\n${hits.join("\n")}`,
      ).toEqual([]);
    });
  }
});
