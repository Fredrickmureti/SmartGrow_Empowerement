/**
 * Architecture guard — Finance record create/edit/peek surface.
 *
 * Enterprise UX standard: every create + edit flow for a Finance
 * business record MUST be a `/new` or `/:id/edit` route composed on top
 * of `RecordFormShell` from `@/design-system`, and every substantial
 * peek surface MUST be a `*PeekSheet.tsx` composed on `PeekScaffold` /
 * `DocumentPeekShell` — never a `Dialog`.
 *
 * Confirm-style pickers (≤6 fields, no line items) may remain `Dialog`
 * and are allowlisted below with a `// confirm-style` marker.
 *
 * This test:
 *   1. Freezes the list of legacy Finance dialog files still awaiting
 *      migration (the allowlist below). Every entry must be REMOVED —
 *      not appended to — as its route pair / peek sheet lands.
 *   2. Forbids any NEW `Create*Dialog.tsx` / `Edit*Dialog.tsx` /
 *      `*DetailDialog.tsx` file appearing under the Finance surface.
 */
import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";

const FINANCE_GLOBS = [
  "src/components/finance",
  "src/components/banking",
  "src/components/accounting",
];

/**
 * Legacy dialogs still awaiting migration. As each migration lands,
 * DELETE the file AND remove its entry here. New Finance record
 * dialogs MAY NOT be added — this list only shrinks.
 *
 * `ApplyDefaultMappingsDialog` is a confirm-style dialog (target column
 * says "keep") but its filename matches the ban pattern, so it is
 * allowlisted permanently with a marker comment. Every other entry is
 * a Phase-1 migration target and MUST leave the list.
 */
const LEGACY_DIALOG_ALLOWLIST = new Set<string>([
  // Migration targets — MUST leave this list as each is completed.
  // Only files matching the ban regex (Create*/Edit*/`*DetailDialog`)
  // belong here. Other legacy Finance dialogs (Apply*, Process*,
  // YearEndClosing*, ConnectBank*, ImportTransactions*, Reconcile*,
  // StartReconciliation*, TransactionRules*, TransferReconcile*) are
  // tracked in docs/design-system/audit/finance.md — not by this
  // filename guard.
  "src/components/finance/CreditNoteDetailDialog.tsx",
  "src/components/banking/EditBankAccountDialog.tsx",
]);

function scanRecordDialogs(): string[] {
  const existing = FINANCE_GLOBS.filter((g) => existsSync(g));
  if (existing.length === 0) return [];
  const cmd =
    "find " +
    existing.join(" ") +
    " -type f -name '*.tsx' 2>/dev/null || true";
  const all = execSync(cmd, { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  return all.filter((p) =>
    /\/(Create|Edit)[A-Za-z0-9]+Dialog\.tsx$|\/[A-Za-z0-9]+DetailDialog\.tsx$/.test(
      p,
    ),
  );
}

describe("finance record dialog ban", () => {
  it("no NEW Create*Dialog / Edit*Dialog / *DetailDialog files under the Finance surface", () => {
    const found = scanRecordDialogs();
    const leaked = found.filter((p) => !LEGACY_DIALOG_ALLOWLIST.has(p));
    expect(
      leaked,
      `New Finance record dialog files landed. Build a /new + /:id/edit ` +
        `route on RecordFormShell (create/edit) or a *PeekSheet on ` +
        `PeekScaffold (detail) instead:\n${leaked.join("\n")}`,
    ).toEqual([]);
  });

  it("the legacy allowlist only shrinks — every entry still exists as a file", () => {
    const found = new Set(scanRecordDialogs());
    const stale = [...LEGACY_DIALOG_ALLOWLIST].filter((p) => !found.has(p));
    expect(
      stale,
      `Allowlist has entries for files that no longer exist — remove them ` +
        `from LEGACY_DIALOG_ALLOWLIST in this test:\n${stale.join("\n")}`,
    ).toEqual([]);
  });
});

// Extension pattern: filename-matching Dialog files above are the coarse
// net. The finer net — arbitrary `<Dialog>` mounts for record CRUD inside
// pages under `src/pages/finance/*` — is caught during code review against
// the ledger at docs/design-system/audit/finance.md.
