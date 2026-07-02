/**
 * Static-source guard for the "inferred computation method" amber banner.
 *
 * The banner contract: when a row carries `parameters._inferred === true`
 * (set by the localization-pack installer / backfill when it had to guess),
 * the editor surfaces an amber alert. Saving the row clears the marker so
 * the banner does not re-appear.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const EDITOR = fs.readFileSync(
  path.resolve(__dirname, "../StatutoryRuleEditor.tsx"),
  "utf8",
);

describe("StatutoryRuleEditor inferred-method banner", () => {
  it("derives the banner state from parameters._inferred === true", () => {
    expect(EDITOR).toMatch(/_inferred\s*\]?\s*===\s*true/);
  });

  it("renders an amber 'inferred from parameters' banner", () => {
    expect(EDITOR).toMatch(/amber/i);
    expect(EDITOR).toMatch(/inferred from parameters/i);
  });

  it("clears the _inferred marker on save", () => {
    // Either explicitly strips the key or sets it to false on the save path.
    expect(EDITOR).toMatch(/_inferred/);
    expect(EDITOR).toMatch(/saving always clears|_inferred:\s*false|delete .*_inferred|_inferred,\s*\.\.\./);
  });
});