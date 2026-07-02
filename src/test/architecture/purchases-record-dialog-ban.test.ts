/**
 * Architecture guard — Purchases record create/edit/peek surface.
 *
 * Enterprise UX standard: every create + edit flow for a Purchases
 * business record MUST be a `/new` or `/:id/edit` route composed on top
 * of the `RecordFormShell` primitive from `@/design-system`, and every
 * peek surface MUST be a `*PeekSheet.tsx` composed on `PeekScaffold` /
 * `DocumentPeekShell` — never a `Dialog`.
 *
 * This test:
 *   1. Freezes the list of legacy Purchases dialog files still awaiting
 *      migration (the allowlist below). Every entry must be REMOVED —
 *      not appended to — as its route pair / peek sheet lands.
 *   2. Forbids any NEW `Create*Dialog.tsx` / `Edit*Dialog.tsx` /
 *      `*DetailDialog.tsx` file appearing under the Purchases surface.
 *
 * If a new file makes this test fail, the fix is NOT to add it to the
 * allowlist — the fix is to build the create/edit route on top of
 * `RecordFormShell`, or the peek surface on top of `PeekScaffold`, and
 * delete the dialog file.
 */
import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";

const PURCHASES_GLOBS = [
  "src/components/purchases",
  "src/components/bills",
  "src/components/vendors",
  "src/components/expenses",
  "src/components/rfqs",
];

/**
 * Legacy dialogs still awaiting migration to `RecordFormShell` (create/edit)
 * or `PeekScaffold` (detail). As each migration lands, DELETE the file AND
 * remove its entry here. New Purchases record dialogs MAY NOT be added to
 * this list — this list only shrinks.
 */
const LEGACY_DIALOG_ALLOWLIST = new Set<string>([]);

function scanRecordDialogs(): string[] {
  const existing = PURCHASES_GLOBS.filter((g) => existsSync(g));
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

describe("purchases record dialog ban", () => {
  it("no NEW Create*Dialog / Edit*Dialog / *DetailDialog files under the Purchases surface", () => {
    const found = scanRecordDialogs();
    const leaked = found.filter((p) => !LEGACY_DIALOG_ALLOWLIST.has(p));
    expect(
      leaked,
      `New Purchases record dialog files landed. Build a /new + /:id/edit ` +
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
