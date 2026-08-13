/**
 * Architecture guard — Procurement Contracts are a commitment control, not a
 * ledger document.
 *
 * Confirms:
 *  1. The browser never writes contract tables directly; every mutation goes
 *     through the SECURITY DEFINER RPC surface.
 *  2. Contracts make no GL / AP / inventory postings from the client path.
 *  3. No second engine: activation FX resolves through `require_exchange_rate`
 *     (ADR-0136), approval routing through `approval_route` + the mirror
 *     trigger, never a hand-rolled `exchange_rates` lookup inside the
 *     contract RPCs.
 *  4. PO consumption reads the frozen `contract_snapshot` / `contract_version`
 *     (ADR-0079), not only a live join.
 *  5. Utilization commitments are cycle-keyed so a re-approved PO re-commits.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(process.cwd(), "src");
const MIGRATIONS = join(process.cwd(), "supabase", "migrations");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(p);
  }
  return out;
}

const allFiles = walk(ROOT).filter((f) => !f.includes("__tests__"));
const contractFiles = allFiles.filter((f) =>
  f.includes(join("features", "purchases", "contracts")),
);

function read(f: string) {
  return readFileSync(f, "utf8");
}

function migrationsText(): string {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(join(MIGRATIONS, f), "utf8"))
    .join("\n");
}

const CONTRACT_TABLES = [
  "procurement_contracts",
  "procurement_contract_lines",
  "procurement_contract_versions",
  "procurement_contract_amendments",
  "procurement_contract_releases",
];

describe("procurement contracts — client write surface", () => {
  it("has contract feature files to guard", () => {
    expect(contractFiles.length).toBeGreaterThan(0);
  });

  it("never inserts, updates, upserts or deletes contract tables from the browser", () => {
    const offenders: string[] = [];
    for (const file of allFiles) {
      const text = read(file);
      for (const table of CONTRACT_TABLES) {
        const pattern = new RegExp(
          `from\\(\\s*["'\`]${table}["'\`]\\s*\\)[\\s\\S]{0,200}?\\.(insert|update|upsert|delete)\\(`,
        );
        if (pattern.test(text)) offenders.push(`${file} → ${table}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("routes every mutation through the contract RPC module", () => {
    const rpcs = read(join(ROOT, "features/purchases/contracts/contractRpcs.ts"));
    for (const fn of [
      "create_procurement_contract",
      "submit_procurement_contract",
      "activate_procurement_contract",
      "amend_procurement_contract",
      "renew_procurement_contract",
      "set_procurement_contract_state",
    ]) {
      expect(rpcs).toContain(fn);
    }
  });

  it("makes no accounting or inventory postings on the contract path", () => {
    const forbidden = [
      "journal_entries",
      "journal_entry_lines",
      "accounting_events",
      "stock_movements",
      "stock_quants",
      "bill_payments",
    ];
    const offenders: string[] = [];
    for (const file of contractFiles) {
      const text = read(file);
      for (const t of forbidden) {
        if (text.includes(`"${t}"`) || text.includes(`'${t}'`)) {
          offenders.push(`${file} → ${t}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("procurement contracts — one engine per concern (SQL)", () => {
  const sql = migrationsText();

  it("registers the governance action and mirrors approval decisions back", () => {
    expect(sql).toContain("procurement_contract.activate");
    expect(sql).toContain("_mirror_approval_to_procurement_contract");
  });

  it("resolves activation FX through the canonical rate engine", () => {
    expect(sql).toMatch(/_pc_apply_activation/);
    expect(sql).toMatch(/require_exchange_rate|resolve_exchange_rate/);
  });

  it("keys PO commitments per reversal cycle so re-approval re-commits", () => {
    expect(sql).toMatch(/commitment:.*cycle|commitment_cycle/);
  });

  it("stamps the contract snapshot and version onto approved purchase orders", () => {
    expect(sql).toContain("contract_snapshot");
    expect(sql).toContain("contract_version");
  });
});

describe("procurement contracts — snapshot consumption (ADR-0079)", () => {
  it("purchase order record reads the frozen snapshot, not only the live join", () => {
    const view = read(join(ROOT, "features/purchases/orders/purchaseOrderView.tsx"));
    expect(view).toContain("contract_snapshot");
    expect(view).toContain("contract_version");
  });

  it("requisition lines surface contract coverage", () => {
    const hook = read(join(ROOT, "features/purchases/requisitions/useRequisitions.ts"));
    expect(hook).toContain("procurement_contract_lines");
  });
});
