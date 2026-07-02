/**
 * EmployeeFormDialog dismissal guard — pinned invariants.
 *
 * The Add Employee modal must never silently discard user input when the
 * user clicks the backdrop or hits Escape. This was the #1 reported pain
 * point on the directory. This test asserts that the four guard pieces
 * still exist in the component:
 *
 *   1. `onInteractOutside` handler that calls `preventDefault()` when dirty.
 *   2. `onEscapeKeyDown` handler that calls `preventDefault()` when dirty.
 *   3. `beforeunload` listener that warns when the form is dirty.
 *   4. A localStorage draft key, so refresh and route changes do not lose
 *      the user's progress.
 *
 * If any of these are removed, this test fails — keeping a future refactor
 * from regressing the UX fix.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(
  join(process.cwd(), "src/components/employees/EmployeeFormDialog.tsx"),
  "utf8",
);

describe("EmployeeFormDialog dismissal guard", () => {
  it("guards outside-click dismissal when the form is dirty", () => {
    expect(SRC).toMatch(/onInteractOutside=\{[^}]*preventDefault/);
  });

  it("guards Escape-key dismissal when the form is dirty", () => {
    expect(SRC).toMatch(/onEscapeKeyDown=\{[^}]*preventDefault/);
  });

  it("warns on tab-close / refresh when the form is dirty", () => {
    expect(SRC).toMatch(/beforeunload/);
  });

  it("persists an add-new draft to localStorage keyed by org", () => {
    expect(SRC).toMatch(/employee-form-draft:v1:/);
    expect(SRC).toMatch(/localStorage\.setItem/);
    expect(SRC).toMatch(/localStorage\.getItem/);
  });

  it("offers a Discard draft affordance once a draft has been saved", () => {
    expect(SRC).toMatch(/Discard draft/);
  });
});