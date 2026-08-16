/**
 * Architecture guard — POS Wave · Phase 9 (offline / retry behaviour).
 *
 * Locks the four client-side invariants closed in this phase:
 *
 *   1. The close-till gate reads `pos_till_close_blockers` (which surfaces the
 *      `open_payment_sessions` blocker); no POS component may fall back to the
 *      legacy `can_close_pos_shift` gate.
 *   2. The offline queue backs off exponentially and classifies permanent
 *      server rejections instead of burning the retry budget.
 *   3. The payment-resume affordance reads the canonical seam
 *      `pos_register_open_payment_sessions` through the payment-session
 *      client wrapper — never a direct table read of the session tables.
 *   4. No client writes to the server-owned payment-session tables.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(process.cwd(), "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const FILES = walk(ROOT).filter((f) => !/\.test\.tsx?$/.test(f) && !/[\\/]test[\\/]/.test(f));

const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

describe("Phase 9 — till close surfaces the payment-session blocker", () => {
  it("CloseShiftDialog calls pos_till_close_blockers", () => {
    const src = read("components/pos/CloseShiftDialog.tsx");
    expect(src).toContain("pos_till_close_blockers");
  });

  it("no POS component calls the legacy can_close_pos_shift gate", () => {
    const offenders = FILES.filter(
      (f) => /[\\/](components|apps|hooks|features)[\\/]/.test(f) &&
        readFileSync(f, "utf8").includes("can_close_pos_shift"),
    ).map((f) => relative(ROOT, f));
    expect(offenders).toEqual([]);
  });
});

describe("Phase 9 — offline queue retry policy", () => {
  const src = read("services/offline/TransactionQueue.ts");

  it("uses RETRY_DELAY_MS as an exponential backoff base with jitter", () => {
    expect(src).toMatch(/export function backoffDelayMs/);
    expect(src).toMatch(/RETRY_DELAY_MS \* 2 \*\*/);
    expect(src).toContain("MAX_RETRY_DELAY_MS");
  });

  it("classifies permanent server rejections and fails them immediately", () => {
    expect(src).toMatch(/export function isPermanentError/);
    expect(src).toMatch(/shift_closed/);
    expect(src).toMatch(/check_violation|violates check constraint/);
    expect(src).toMatch(/const isPermanentlyFailed = permanent \|\|/);
  });

  it("honours the backoff schedule when draining", () => {
    expect(src).toContain("getDueTransactions");
    expect(src).toMatch(/nextAttemptAt/);
  });
});

describe("Phase 9 — payment resume affordance", () => {
  it("reads the canonical open-session seam through the client wrapper", () => {
    const wrapper = read("lib/pos/paymentSessionClient.ts");
    expect(wrapper).toContain("pos_register_open_payment_sessions");
    const banner = read("components/pos/PaymentResumeBanner.tsx");
    expect(banner).toContain("listOpenSessions");
    expect(banner).not.toContain("supabase.rpc");
    expect(banner).not.toContain('from("pos_payment_sessions')
  });

  it("is mounted on the terminal sale surface", () => {
    expect(read("apps/pos/terminal/sale/SaleWorkspace.tsx")).toContain("PaymentResumeBanner");
  });

  it("no client code writes to the payment-session tables", () => {
    const tables = [
      "pos_payment_sessions",
      "pos_payment_session_tenders",
      "pos_payment_session_apply_log",
    ];
    const offenders: string[] = [];
    for (const f of FILES) {
      const src = readFileSync(f, "utf8");
      for (const t of tables) {
        const re = new RegExp(`from\\(["'\`]${t}["'\`]\\)[\\s\\S]{0,120}?\\.(insert|update|upsert|delete)\\(`);
        if (re.test(src)) offenders.push(`${relative(ROOT, f)} → ${t}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
