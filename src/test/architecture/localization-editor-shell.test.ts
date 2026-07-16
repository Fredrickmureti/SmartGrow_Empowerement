/**
 * Architecture guard — Phase 1 of the localization editor unification
 * (see docs/adr/0056 + the approved plan).
 *
 * Invariant: the full-page certificate editor shell lives in the shared
 * feature (`src/features/localization/routes/CertificateEditorPage.tsx`)
 * and every route that mounts the certificate editor as a page routes
 * through it. Admin and tenant cannot maintain a private page shell.
 *
 * This test fails if:
 *   - the shared shell is deleted or moved without updating this guard;
 *   - a page under `src/pages/` imports `CertificateTemplateEditor`
 *     directly (page-level mounts must go via `CertificateEditorPage`);
 *   - the admin route file forgets to mount the shared shell.
 *
 * In-shell drawer mounts inside `PackEntityTabs` (return templates
 * still open in the sheet, admin certs already navigate away) are
 * NOT flagged — those are entity-list actions, not page routes.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { globSync } from "glob";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");

const SHARED_SHELL = join(
  ROOT,
  "src/features/localization/routes/CertificateEditorPage.tsx",
);

describe("localization certificate editor shell", () => {
  it("shared full-page shell exists at the canonical path", () => {
    expect(existsSync(SHARED_SHELL)).toBe(true);
    const src = readFileSync(SHARED_SHELL, "utf8");
    expect(src).toMatch(/export function CertificateEditorPage/);
    // The shell owns the mount — never a duplicate.
    expect(src).toMatch(/CertificateTemplateEditor/);
  });

  it("shared shell is exported from the feature barrel", () => {
    const barrel = readFileSync(
      join(ROOT, "src/features/localization/index.ts"),
      "utf8",
    );
    expect(barrel).toMatch(/CertificateEditorPage/);
  });

  it("no page route imports CertificateTemplateEditor directly — must go via CertificateEditorPage", () => {
    // Page files under src/pages/ are route mounts. In-feature components
    // (PackEntityTabs list-item drawers) are intentionally excluded — those
    // are entity actions, not page routes, and are covered by Phase 2.
    const pageFiles = globSync("src/pages/**/*.tsx", { cwd: ROOT, absolute: true });
    const offenders: string[] = [];
    for (const file of pageFiles) {
      const src = readFileSync(file, "utf8");
      // Allow `import type` — types don't cause runtime mount duplication.
      const valueImport = new RegExp(
        String.raw`import\s+(?!type\s)\{[^}]*CertificateTemplateEditor[^}]*\}\s+from\s+["'][^"']*CertificateTemplateEditor["']`,
      );
      if (valueImport.test(src)) {
        offenders.push(file.replace(ROOT + "/", ""));
      }
    }
    expect(
      offenders,
      `Page routes must mount <CertificateEditorPage /> instead of importing CertificateTemplateEditor directly:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("admin certificate edit route mounts the shared shell", () => {
    const admin = readFileSync(
      join(ROOT, "src/pages/admin/AdminLocalizationCertificateEdit.tsx"),
      "utf8",
    );
    expect(admin).toMatch(/CertificateEditorPage/);
    expect(admin).toMatch(/mode=["']admin["']/);
  });
});
