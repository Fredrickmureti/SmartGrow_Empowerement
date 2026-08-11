/**
 * Architecture ratchet: purchase-order status has a single writer.
 *
 * The po_status state machine lives in the database: the
 * `*_purchase_order` RPCs own every transition, and the client only names
 * the intent (submit / approve / reject / release / acknowledge / cancel /
 * revise / close). Any raw `status` write or direct line-item delete from
 * application code bypasses SoD checks, row locks, event emission, and the
 * commercial-field immutability trigger — it is a regression by definition.
 *
 * Allow-listed escapes: none. If a new legitimate path appears, add a
 * narrow exemption comment here, not a silent bypass.
 */
import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";

const APP_PATHS = ["src", "supabase/functions"];
const SELF = "po-status-single-writer.test.ts";

function rgFiles(pattern: string): string[] {
  let out = "";
  try {
    out = execSync(`rg -l -U '${pattern}' ${APP_PATHS.join(" ")}`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return []; // rg exits 1 when there are no matches
  }
  return out
    .split("\n")
    .map((s) => s.trim())
    .filter((f) => f && !f.includes(SELF));
}

describe("PO status single writer", () => {
  it("no application code writes purchase_orders.status via update payloads", () => {
    const offenders = rgFiles(
      String.raw`from\(["']purchase_orders["']\)[\s\S]{0,400}?\.update\(\s*\{[\s\S]{0,400}?\bstatus\s*:`,
    );
    expect(offenders).toEqual([]);
  });

  it("no application code deletes purchase_order_items directly (use update_po_items_atomic)", () => {
    const offenders = rgFiles(
      String.raw`from\(["']purchase_order_items["']\)[\s\S]{0,160}?\.delete\(`,
    );
    expect(offenders).toEqual([]);
  });
});
