/**
 * Architecture guard — Finance record create/edit/peek surface.
 *
 * Enterprise UX standard: every create + edit flow for a Finance
 * business record MUST be a `/new` or `/:id/edit` route composed on top
 * of `RecordFormShell` from `@/design-system`, and every substantial
 * peek surface MUST be a `*PeekSheet.tsx` composed on `PeekScaffold` /
 * `DocumentPeekShell` — never a `Dialog` and never a `*Sheet.tsx`
 * form-in-a-sheet.
 *
 * The guard is now FROZEN (post Wave 11): allowlist contains only
 * genuine confirm-style utilities that fit the ≤6-field `DetailSheet`
 * standard. Every other Create/Edit/Detail dialog and every ad-hoc
 * `*Sheet.tsx` form under the Finance surface is forbidden.
 */
import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";

const FINANCE_GLOBS = [
  "src/components/finance",
  "src/components/banking",
  "src/components/accounting",
  "src/components/budgets",
  "src/features/finance",
];

/**
 * Frozen allowlist — genuine confirm-style utilities that fit the
 * ≤6-field `DetailSheet` standard. Anything else is forbidden.
 *
 * `CopyBudgetDetailSheet` is intentionally absent: `*DetailSheet.tsx` is
 * the approved confirm-style naming convention, so the scanner no longer
 * flags it and an allowlist entry would be dead weight.
 */
const LEGACY_DIALOG_ALLOWLIST = new Set<string>([
  // Confirm-style: pre-flight preview of mapping keep/overwrite (no
  // record fields). Explicitly not a record editor.
  "src/components/finance/ApplyDefaultMappingsDialog.tsx",
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
  return all.filter((p) => {
    // Ban: any Create*Dialog / Edit*Dialog / *DetailDialog file
    // (matches the original coarse net), any verb-noun *Dialog file
    // that hosts a record editor (Reconcile*Dialog, Match*Dialog,
    // etc.), and any *Sheet.tsx form under src/features/finance.
    const dialogBan =
      /\/(Create|Edit)[A-Za-z0-9]+Dialog\.tsx$/.test(p) ||
      /\/[A-Za-z0-9]+DetailDialog\.tsx$/.test(p) ||
      /\/(Reconcile|Match|Transfer|Apply|Process|Import|Configure)[A-Za-z0-9]*Dialog\.tsx$/.test(
        p,
      );
    // Sheet bans (Wave 8): reject the exact "form-in-a-sheet" naming
    // patterns Wave 8 eliminated for budgets. Legitimate confirm-style
    // utilities use *DetailSheet.tsx; object previews use
    // *PeekSheet.tsx; small config surfaces (analytic groups, close
    // period, generate periods, dispose asset, depreciation run) are
    // intentionally out of scope for this net and are audited via the
    // ledger at docs/design-system/audit/finance.md.
    const sheetBan =
      /^src\/features\/finance\/.*\/(?:[A-Za-z0-9]+)?FormSheet\.tsx$/.test(p) ||
      /^src\/features\/finance\/.*\/(?:[A-Za-z0-9]+)?ItemSheet\.tsx$/.test(p) ||
      /^src\/features\/finance\/.*\/Manage[A-Za-z0-9]+Sheet\.tsx$/.test(p);
    return dialogBan || sheetBan;
  });
}

describe("finance record dialog ban", () => {
  it("no forbidden Dialog or Sheet files under the Finance surface", () => {
    const found = scanRecordDialogs();
    const leaked = found.filter((p) => !LEGACY_DIALOG_ALLOWLIST.has(p));
    expect(
      leaked,
      `New Finance record dialog/sheet files landed. Build a /new + ` +
        `/:id/edit route on RecordFormShell (create/edit) or a ` +
        `*PeekSheet on PeekScaffold (detail) instead. Confirm-style ` +
        `≤6-field utilities must use the *DetailSheet naming convention ` +
        `and be explicitly allowlisted in this test:\n${leaked.join("\n")}`,
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
