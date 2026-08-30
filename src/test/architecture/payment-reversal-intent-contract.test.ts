import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * ADR 0012 — Payment reversal intent model.
 *
 * These guards lock the architectural invariants documented in
 * docs/adr/0012-payment-reversal-intent-model.md so they cannot regress
 * silently as new agents touch the payment subsystem.
 */

const PROJECT_ROOT = process.cwd();
const MIGRATIONS_DIR = join(PROJECT_ROOT, "supabase", "migrations");
const SRC_DIR = join(PROJECT_ROOT, "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

function readAllMigrations(): { file: string; sql: string }[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => ({ file: f, sql: readFileSync(join(MIGRATIONS_DIR, f), "utf8") }));
}

describe("ADR 0012 — payment reversal intent model migration shape", () => {
  const migrations = readAllMigrations();

  const intentMigration = migrations.find(({ sql }) =>
    /CREATE TYPE public\.payment_reversal_reason/.test(sql) &&
    /payment_reversal_events/.test(sql) &&
    /customer_refunds/.test(sql)
  );

  it("the intent-model migration exists", () => {
    expect(
      intentMigration,
      "ADR 0012 migration (payment_reversal_reason enum + payment_reversal_events + customer_refunds) is missing"
    ).toBeDefined();
  });

  it("defines the full payment_reversal_reason enum", () => {
    const sql = intentMigration!.sql;
    for (const value of [
      "data_entry_error",
      "duplicate_payment",
      "bank_transfer_failed",
      "wrong_invoice_applied",
      "customer_refund_requested",
      "invoice_cancelled_keep_as_credit",
      "invoice_cancelled_keep_as_advance",
    ]) {
      expect(sql, `enum value '${value}' missing`).toMatch(new RegExp(`'${value}'`));
    }
  });

  it("adds outstanding_amount + applied_amount + reversal_reason to payments", () => {
    const sql = intentMigration!.sql;
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS\s+outstanding_amount\s+numeric/i);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS\s+applied_amount\s+numeric/i);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS\s+reversal_reason\s+public\.payment_reversal_reason/i);
  });

  it("installs the amount-split invariant trigger", () => {
    const sql = intentMigration!.sql;
    expect(sql).toMatch(/FUNCTION\s+public\.enforce_payment_amount_split/i);
    expect(sql).toMatch(/trg_enforce_payment_amount_split/);
    // Invariant: amount = outstanding + applied (tolerance check)
    expect(sql).toMatch(/NEW\.outstanding_amount\s*\+\s*NEW\.applied_amount/);
  });

  it("customer_refunds enforces exclusive-or between payment and credit-note source", () => {
    const sql = intentMigration!.sql;
    expect(sql).toMatch(/customer_refund_source_xor/);
    expect(sql).toMatch(/source_payment_id\s+IS NOT NULL/i);
    expect(sql).toMatch(/source_credit_note_id\s+IS NOT NULL/i);
  });

  it("payment_reversal_events has no client INSERT/UPDATE/DELETE policy", () => {
    const sql = intentMigration!.sql;
    // Only a SELECT policy is allowed; mutations go through SECURITY DEFINER.
    const eventBlock = sql.split("customer_refunds")[0] ?? "";
    expect(eventBlock).not.toMatch(/POLICY[^"\n]*payment_reversal_events[^\n]*\n[^;]*FOR\s+(INSERT|UPDATE|DELETE)/i);
  });

  it("both new tables enable RLS", () => {
    const sql = intentMigration!.sql;
    expect(sql).toMatch(/ALTER TABLE public\.payment_reversal_events ENABLE ROW LEVEL SECURITY/i);
    expect(sql).toMatch(/ALTER TABLE public\.customer_refunds ENABLE ROW LEVEL SECURITY/i);
  });
});

describe("ADR 0012 — P1a GL primitive + invariant hardening", () => {
  const migrations = readAllMigrations();

  it("a migration seeds customer_deposits mapping for every business", () => {
    const seedMig = migrations.find(({ sql }) =>
      /default_account_settings/.test(sql) &&
      /'customer_deposits'/.test(sql) &&
      /FROM\s+public\.businesses/i.test(sql)
    );
    expect(
      seedMig,
      "P1a seeding migration (auto-create customer_deposits per business) is missing"
    ).toBeDefined();
  });

  it("a migration installs the invoice_id-flip recompute trigger", () => {
    const m = migrations.find(({ sql }) =>
      /recompute_payment_split_on_invoice_flip/.test(sql) &&
      /BEFORE UPDATE OF invoice_id ON public\.payments/i.test(sql)
    );
    expect(m, "invoice_id-flip safety trigger is missing").toBeDefined();
  });

  it("a migration adds the reversal-events idempotency unique index", () => {
    const m = migrations.find(({ sql }) =>
      /uq_payment_reversal_events_idem/.test(sql) &&
      /client_request_id/.test(sql)
    );
    expect(m, "idempotency unique index on payment_reversal_events missing").toBeDefined();
  });

  it("a migration adds the closed-period helper is_period_open", () => {
    const m = migrations.find(({ sql }) =>
      /FUNCTION\s+public\.is_period_open/i.test(sql)
    );
    expect(m, "is_period_open() helper missing — reversal RPCs cannot guard closed periods").toBeDefined();
  });
});

describe("ADR 0012 — call-site guards in src/", () => {
  const files = walk(SRC_DIR);

  // Ratchet: snapshot the existing direct callers of void_journal_entry_atomic
  // outside the two canonical hooks. ADR 0012 (P3 / follow-up phase) migrates
  // each entry through useVoidJournalEntry — until then, the list must not grow
  // and no NEW file may introduce a direct call.
  const VOID_RPC_BASELINE = new Set([
    "src/hooks/useTransactionReversal.ts",
    "src/hooks/useVoidJournalEntry.ts",
    "src/hooks/useBills.ts",
    "src/hooks/useExpenses.ts",
    "src/hooks/useExpensesPaginated.ts",
    "src/hooks/useJournalEntries.ts",
    "src/integrations/supabase/types.ts",
  ]);

  it("no NEW call site for void_journal_entry_atomic (ratchet)", () => {
    const offenders = files
      .filter((f) => {
        const rel = f.slice(PROJECT_ROOT.length + 1);
        if (VOID_RPC_BASELINE.has(rel)) return false;
        if (rel.startsWith("src/test/")) return false;
        const content = readFileSync(f, "utf8");
        return /void_journal_entry_atomic/.test(content);
      })
      .map((f) => f.slice(PROJECT_ROOT.length + 1));
    expect(
      offenders,
      `New direct callers of void_journal_entry_atomic detected. Route through useVoidJournalEntry / useTransactionReversal instead:\n${offenders.join("\n")}`
    ).toEqual([]);
  });

  // P3 closed: `src/components/invoices/RecordPaymentDialog.tsx` and
  // `src/components/sales/RecordPaymentDialog.tsx` were merged into the single
  // `src/components/payments/RecordCustomerPaymentDialog.tsx`. Exactly one
  // customer money-in component may exist — a second copy is how the two
  // dialogs drifted apart in the first place.
  it("exactly one customer payment recording component exists (ratchet)", () => {
    const matches = files.filter((f) =>
      /\/(RecordPaymentDialog|RecordCustomerPaymentDialog)\.tsx$/.test(f),
    );
    expect(
      matches.map((f) => f.slice(PROJECT_ROOT.length + 1)),
      "There must be exactly one customer payment dialog: src/components/payments/RecordCustomerPaymentDialog.tsx",
    ).toEqual(["src/components/payments/RecordCustomerPaymentDialog.tsx"]);
  });


  // ADR 0012 — every voidPayment / unapplyPayment / refundCustomer call from
  // UI code must go through ReversePaymentWizard, which builds the reasonCode
  // from the operator's plain-language answer. Direct callers bypass intent
  // capture and silently corrupt the audit trail.
  const REVERSAL_HOOK_ALLOWLIST = new Set([
    "src/hooks/useTransactionReversal.ts",
    "src/components/payments/ReversePaymentWizard.tsx",
  ]);

  it("no direct voidPayment(/unapplyPayment(/refundCustomer( calls outside ReversePaymentWizard", () => {
    const offenders = files
      .filter((f) => {
        const rel = f.slice(PROJECT_ROOT.length + 1);
        if (REVERSAL_HOOK_ALLOWLIST.has(rel)) return false;
        if (rel.startsWith("src/test/")) return false;
        const content = readFileSync(f, "utf8");
        return /\b(voidPayment|unapplyPayment|refundCustomer)\s*\(/.test(content);
      })
      .map((f) => f.slice(PROJECT_ROOT.length + 1));
    expect(
      offenders,
      `New direct callers of reversal hooks detected. Mount ReversePaymentWizard instead:\n${offenders.join("\n")}`
    ).toEqual([]);
  });

  // ADR 0012 Wave R2 — UnreconcilePaymentDialog was deleted. The
  // wizard's `wrong_invoice_applied` reason (op = unapply) is the only
  // supported "detach payment from invoice" entry point. Re-introducing
  // the legacy component or its hook is banned.
  it("UnreconcilePaymentDialog is not re-introduced", () => {
    const offenders = files
      .filter((f) => {
        const rel = f.slice(PROJECT_ROOT.length + 1);
        if (rel.startsWith("src/test/")) return false;
        const content = readFileSync(f, "utf8");
        // Allow narrative comment references; only flag real code usages
        // (imports / JSX / identifier calls).
        return content
          .split("\n")
          .some((line) => {
            const trimmed = line.trim();
            if (trimmed.startsWith("//") || trimmed.startsWith("*")) return false;
            return /UnreconcilePaymentDialog/.test(line);
          });
      })
      .map((f) => f.slice(PROJECT_ROOT.length + 1));
    expect(
      offenders,
      `UnreconcilePaymentDialog references found — this component was retired in ADR 0012 Wave R2. Use <ReversePaymentWizard initialReasonCode="wrong_invoice_applied" /> instead:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("unreconcilePayment is not called from UI code", () => {
    const offenders = files
      .filter((f) => {
        const rel = f.slice(PROJECT_ROOT.length + 1);
        if (rel === "src/hooks/useTransactionReversal.ts") return false;
        if (rel.startsWith("src/test/")) return false;
        const content = readFileSync(f, "utf8");
        return /\bunreconcilePayment\s*\(/.test(content) ||
          /\.\s*unreconcilePayment\b/.test(content);
      })
      .map((f) => f.slice(PROJECT_ROOT.length + 1));
    expect(
      offenders,
      `Callers of unreconcilePayment detected. This path was retired in ADR 0012 Wave R2:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});

describe("ReversePaymentWizard — Rules-of-Hooks invariant", () => {
  // Regression guard for the /sales/payments crash:
  // "Rendered more hooks than during the previous render."
  // Every React hook in the wizard MUST appear ABOVE the
  // `if (!payment) return null` guard; otherwise the first click on a
  // payment row (which transitions `payment` from null → object) grows
  // the hook count and React aborts the render.
  it("places every hook above the `if (!payment) return null` guard", () => {
    const src = readFileSync(
      join(SRC_DIR, "components/payments/ReversePaymentWizard.tsx"),
      "utf8",
    );

    const lines = src.split("\n");
    const componentStartLine = lines.findIndex((l) =>
      l.includes("export function ReversePaymentWizard("),
    );
    expect(componentStartLine, "ReversePaymentWizard component not found").toBeGreaterThan(-1);

    // Find the actual statement (not a mention inside a comment).
    const guardLine = lines.findIndex((l, i) => {
      if (i <= componentStartLine) return false;
      const t = l.trim();
      if (t.startsWith("//") || t.startsWith("*")) return false;
      return /^if\s*\(!payment\)\s*return\s+null\s*;?\s*$/.test(t);
    });
    expect(guardLine, "`if (!payment) return null` guard missing").toBeGreaterThan(-1);

    const offendingLines = lines.slice(guardLine + 1).filter((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) return false;
      return /\buse[A-Z]\w*\s*\(/.test(line);
    });

    expect(
      offendingLines.map((l) => l.trim()),
      "Hook call detected below `if (!payment) return null` in ReversePaymentWizard.tsx — " +
        "this re-introduces the conditional-hooks crash on /sales/payments. " +
        "Move the hook above the guard.",
    ).toEqual([]);
  });
});
