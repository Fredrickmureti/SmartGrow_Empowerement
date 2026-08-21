import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The AI assistant may only quote figures the ledger actually produced.
 *
 * Two real defects motivated these ratchets:
 *  - the bank balance was read from `bank_accounts.current_balance`, a column
 *    that does not exist; the error was swallowed and the user was told
 *    "KES 0.00" while the real cash position was ~KES 96,420;
 *  - "Account Balances by Type" summed a 50-row page of the chart of accounts,
 *    so the liabilities total was a truncated sample presented as a total.
 *
 * These tests fail if either shape comes back.
 */

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

const ASSISTANT = "supabase/functions/ai-assistant/index.ts";
const SNAPSHOT = "supabase/functions/_shared/financialSnapshot.ts";

describe("ai-assistant financial truth", () => {
  const assistant = read(ASSISTANT);
  const snapshot = read(SNAPSHOT);

  it("never reads a non-existent denormalised balance column", () => {
    expect(assistant).not.toMatch(/current_balance/);
  });

  it("takes cash from the sanctioned bank_account_positions projection", () => {
    expect(snapshot).toMatch(/bank_account_positions/);
    expect(assistant).toMatch(/fetchBankPositions/);
  });

  it("takes revenue, expenses and type balances from posted journal entries", () => {
    expect(snapshot).toMatch(/get_account_movements/);
    expect(assistant).toMatch(/fetchLedgerBalances/);
  });

  it("takes receivables from the finance_ar_open_items projection", () => {
    expect(snapshot).toMatch(/finance_ar_open_items/);
    expect(assistant).toMatch(/fetchReceivables/);
  });

  it("pages aggregate reads to exhaustion instead of a fixed sample", () => {
    expect(snapshot).toMatch(/readAll/);
    expect(snapshot).toMatch(/paging|page/i);
  });

  it("reports a failed read as unavailable rather than a zero", () => {
    expect(snapshot).toMatch(/unavailable/);
    expect(assistant).toMatch(/UNAVAILABLE/);
    // The summary fields must admit null so a failure cannot masquerade as 0.
    expect(assistant).toMatch(/totalBankBalance: number \| null/);
  });

  it("instructs the model never to substitute a figure it was not given", () => {
    expect(assistant).toMatch(/Never substitute 0/);
  });
});

describe("ai-assistant data tool whitelist", () => {
  const tools = read("supabase/functions/ai-assistant/dataTools.ts");

  it("exposes no column that does not exist on the table", () => {
    // Each of these was in the whitelist and would make `query_data` fail,
    // leaving the model to answer from imagination.
    for (const phantom of [
      "current_balance",
      "account_number_masked",
      "expected_delivery_date",
      "rate_date",
      '"valid_until"',
      '"leave_type"',
      '"progress", "business_id"',
    ]) {
      expect(tools).not.toContain(phantom);
    }
  });

  it("tells the model that account balances are not stored on the tables", () => {
    expect(tools).toMatch(/bank_account_positions/);
    expect(tools).toMatch(/posted journal entries/);
  });
});
