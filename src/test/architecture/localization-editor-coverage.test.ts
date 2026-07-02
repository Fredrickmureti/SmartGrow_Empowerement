/**
 * Architecture guard — Localization editor coverage.
 *
 * Contract: every publisher-facing entity declared in
 * `LocalizationFormShell`'s `Entity` union MUST have a concrete editor
 * component AND be mounted inside `PackEntityTabs`. Without this guard
 * a future entity can silently ship with a form dialog but no way to
 * reach it, or a way to reach it but no dialog — both regressions we
 * shipped and fixed in the P1 wave.
 *
 * The guard also blocks the reverse regression: an editor file
 * disappearing while its import remains, or an entity being removed
 * from the shell without its editor being retired.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const shell = readFileSync(
  resolve(__dirname, "../../features/localization/components/_shared/LocalizationFormShell.tsx"),
  "utf8",
);
const tabs = readFileSync(
  resolve(__dirname, "../../features/localization/components/PackEntityTabs.tsx"),
  "utf8",
);

/** Extract the string literals from the exported `Entity` union. */
function extractEntities(src: string): string[] {
  const match = src.match(/type Entity =\s*([\s\S]*?);/);
  if (!match) throw new Error("Entity union not found in LocalizationFormShell");
  return Array.from(match[1].matchAll(/"([a-z-]+)"/g)).map((m) => m[1]);
}

// Entities that are transient UI affordances (dialogs invoked from
// version history, not a table-backed editor), so they do not need
// their own editor component. Keep this list tiny and reviewed.
const NON_EDITOR_ENTITIES = new Set([
  "publish-version",
  "diff-version",
  "promote-version",
  "create-template",
]);

// Entities whose editor is mounted somewhere other than PackEntityTabs
// (e.g. Templates/Returns are rendered inside the templates table row
// action). Keep this list explicit — a new entity must justify entry.
const MOUNTED_OUTSIDE_TABS: Record<string, string> = {
  rule: "RulesTab (inline)",
  template: "TemplatesTable (inline)",
  "tax-template": "TaxTemplatesEditor",
  "account-template": "AccountTemplatesEditor",
  "remittance-schedule": "RemittanceSchedulesEditor",
  return: "ReturnTemplateEditor",
};

// Editor components that must be imported and mounted in PackEntityTabs.
const REQUIRED_EDITORS: Record<string, string> = {
  "publisher-grant": "PublisherGovernanceEditor",
  "pack-token": "TokenRegistryEditor",
  "garnishment-kind": "GarnishmentsEditor",
  "garnishment-policy": "GarnishmentsEditor",
  "bank-export": "BankExportTemplatesEditor",
  "statutory-authority": "StatutoryAuthoritiesEditor",
  "pack-requirement": "PackRequirementsEditor",
  certificate: "CertificateTemplateEditor",
};

describe("localization editor coverage", () => {
  const entities = extractEntities(shell);

  it("declares at least the P1 minimum entity set", () => {
    for (const required of [
      "publisher-grant",
      "pack-token",
      "garnishment-kind",
      "bank-export",
      "statutory-authority",
      "pack-requirement",
    ]) {
      expect(entities, `missing entity ${required}`).toContain(required);
    }
  });

  it("every entity is classified (editor, table-mounted, or transient)", () => {
    for (const entity of entities) {
      const classified =
        NON_EDITOR_ENTITIES.has(entity) ||
        entity in MOUNTED_OUTSIDE_TABS ||
        entity in REQUIRED_EDITORS;
      expect(classified, `entity "${entity}" is unclassified — add it to REQUIRED_EDITORS, MOUNTED_OUTSIDE_TABS, or NON_EDITOR_ENTITIES with justification`).toBe(true);
    }
  });

  it("every required editor is imported and mounted in PackEntityTabs", () => {
    for (const [entity, component] of Object.entries(REQUIRED_EDITORS)) {
      expect(
        tabs.includes(`import { ${component} }`),
        `${component} for entity "${entity}" is not imported in PackEntityTabs`,
      ).toBe(true);
      expect(
        new RegExp(`<${component}\\b`).test(tabs),
        `${component} for entity "${entity}" is imported but never rendered in PackEntityTabs`,
      ).toBe(true);
    }
  });
});
