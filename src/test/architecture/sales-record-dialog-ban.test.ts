/**
 * Architecture guard — Sales record create/edit surface.
 *
 * Enterprise UX standard: every create + edit flow for a Sales business
 * record MUST be a `/new` or `/:id/edit` route composed on top of the
 * `RecordFormShell` primitive from `@/design-system`. Sheet/Dialog-
 * driven create/edit surfaces (`Create*Dialog`, `Edit*Dialog`) are
 * being retired per docs/design-system/audit/sales.md.
 *
 * This test:
 *   1. Freezes the list of legacy Sales create/edit dialog files still
 *      awaiting migration (the allowlist below). Every entry must be
 *      REMOVED — not appended to — as its route pair is landed.
 *   2. Forbids any NEW `Create*Dialog.tsx` / `Edit*Dialog.tsx` file
 *      appearing under the Sales surface paths.
 *
 * If a new file makes this test fail, the fix is not to add it to the
 * allowlist — the fix is to build the create/edit route on top of
 * `RecordFormShell` and delete the dialog file.
 */
import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";

const SALES_GLOBS = [
  "src/components/invoices",
  "src/components/estimates",
  "src/components/sales",
  "src/components/finance",
];

/**
 * Legacy dialogs still awaiting Phase-3 migration. As each route pair
 * lands, delete the file AND remove its entry here. New sales dialogs
 * MAY NOT be added to this list — this list only shrinks.
 */
const LEGACY_DIALOG_ALLOWLIST = new Set<string>([
  // All Sales record dialogs migrated to /new + /:id/edit routes.
]);

function scanCreateEditDialogs(): string[] {
  const cmd =
    "rg -l --glob '!src/test/**' " +
    "-e '^' " +
    SALES_GLOBS.map((g) => `${g}`).join(" ") +
    " 2>/dev/null || true";
  // Just list all files under the sales dirs, then filter by name.
  const all = execSync(cmd, { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  return all.filter((p) => /\/(Create|Edit)[A-Za-z0-9]+Dialog\.tsx$/.test(p));
}

describe("sales record dialog ban", () => {
  it("no NEW Create*Dialog / Edit*Dialog files under the Sales surface", () => {
    const found = scanCreateEditDialogs();
    const leaked = found.filter((p) => !LEGACY_DIALOG_ALLOWLIST.has(p));
    expect(
      leaked,
      `New sales create/edit dialog files landed. Build a /new + /:id/edit ` +
        `route on top of RecordFormShell instead:\n${leaked.join("\n")}`,
    ).toEqual([]);
  });

  it("the legacy allowlist only shrinks — every entry still exists as a file", () => {
    // If an allowlisted file has been deleted (migration landed), the
    // allowlist entry must go with it. This test catches stale entries.
    const found = new Set(scanCreateEditDialogs());
    const stale = [...LEGACY_DIALOG_ALLOWLIST].filter((p) => !found.has(p));
    expect(
      stale,
      `Allowlist has entries for files that no longer exist — remove them ` +
        `from LEGACY_DIALOG_ALLOWLIST in this test:\n${stale.join("\n")}`,
    ).toEqual([]);
  });
});
